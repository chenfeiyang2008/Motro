// 课程发布集成测试：发布事务原子性、不可变快照、幂等重试、并发不重复编号、
// stale draft 拒绝、release row 禁止 update/delete、current pointer 切换与跨课程拒绝。
// 需要运行中的 PostgreSQL（compose 的 db 服务）。连接不可用时整个 describe 跳过。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createPool, loadDbConfigFromEnv, migrate } from "@motro/db";
import { createApp } from "../../../../apps/api/src/bootstrap-app.js";
import { PasswordService } from "../../../../apps/api/src/auth/password.service.js";

type App = Awaited<ReturnType<typeof createApp>>;

const config = loadDbConfigFromEnv();
const MIGRATIONS_DIR = resolve(process.cwd(), "db/migrations");
const probePool = createPool({ ...config, max: 1 });

async function canConnect(): Promise<boolean> {
  try {
    await probePool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await probePool.end();
  }
}

const dbAvailable = await canConnect();

interface Res {
  statusCode: number;
  json(): unknown;
  headers: Record<string, unknown>;
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface Client {
  warm(): Promise<void>;
  req(
    method: HttpMethod,
    url: string,
    opts?: { payload?: object; headers?: Record<string, string> },
  ): Promise<Res>;
}

function makeClient(app: App): Client {
  const cookies: Record<string, string> = {};
  let csrf = "";
  const captureCookies = (res: { headers: Record<string, unknown> }): void => {
    const raw = res.headers["set-cookie"];
    const lines = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
    for (const line of lines) {
      const pair = line.split(";")[0];
      if (!pair) continue;
      const idx = pair.indexOf("=");
      if (idx > 0) {
        const name = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1);
        if (name === "motro_session" && value === "") delete cookies[name];
        else cookies[name] = value;
      }
    }
    if (cookies["motro_csrf"]) csrf = cookies["motro_csrf"];
  };
  return {
    async warm() {
      const res = await app.inject({ method: "GET", url: "/api/v1/health/live" });
      captureCookies(res);
    },
    async req(method, url, opts = {}) {
      if (method !== "GET" && csrf === "") await this.warm();
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      const jar = Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
      if (jar) headers.cookie = jar;
      if (method !== "GET") headers["x-csrf-token"] = csrf;
      const res = await app.inject({
        method,
        url,
        headers,
        ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
      });
      captureCookies(res);
      return res as unknown as Res;
    },
  };
}

interface SetupResult {
  courseId: string;
  draftVersion: number;
  unitId: string;
  itemId: string;
  entryId: string;
}

describe.skipIf(!dbAvailable && process.env.MOTRO_REQUIRE_DB !== "1")(
  "admin course publishing",
  () => {
    let app: App;
    let admin: Client;

    beforeAll(async () => {
      await migrate(config, MIGRATIONS_DIR);
      const adminPool = createPool({ ...config, max: 1 });
      const ps = new PasswordService();
      const hash = await ps.hashPassword("publish-itest-admin-pass-123");
      await adminPool.query(
        `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
         VALUES ('publish-itest-admin', 'Publish ITest Admin', 'admin', 'active', 'Asia/Shanghai', 10, $1, false)
         ON CONFLICT (username) DO UPDATE SET password_hash = $1, must_change_password = false, status = 'active'`,
        [hash],
      );
      await adminPool.end();

      app = await createApp();
      await app.init();
      admin = makeClient(app);
      const login = await admin.req("POST", "/api/v1/auth/login", {
        payload: { username: "publish-itest-admin", password: "publish-itest-admin-pass-123" },
      });
      expect(login.statusCode).toBe(200);
    });

    afterAll(async () => {
      await app.close();
    });

    function body(res: Res): Record<string, unknown> {
      return res.json() as Record<string, unknown>;
    }

    function uniq(prefix: string): string {
      return `${prefix}-${randomBytes(4).toString("hex")}`;
    }

    async function setupValidCourse(): Promise<SetupResult> {
      const entryRes = await admin.req("POST", "/api/v1/admin/lexical-entries", {
        payload: { canonicalSpelling: uniq("pubword"), confirmDuplicate: false },
      });
      expect(entryRes.statusCode).toBe(201);
      const entryId = (body(entryRes) as { id?: string }).id as string;

      const slug = uniq("pubcourse");
      const res = await admin.req("POST", "/api/v1/admin/courses", {
        payload: { slug, title: "发布课程", level: "a1", description: "课程描述" },
      });
      expect(res.statusCode).toBe(201);
      const created = body(res) as { courseId?: string; draftVersion?: number };
      const courseId = created.courseId as string;
      let version = created.draftVersion ?? 1;

      const unitId = randomUUID();
      const u = await admin.req("POST", `/api/v1/admin/courses/${courseId}/draft/units/${unitId}`, {
        payload: { title: "基础词汇", description: "单元描述", draftVersion: version },
      });
      expect(u.statusCode).toBe(201);
      version = (body(u) as { version?: number }).version ?? version;

      const itemId = randomUUID();
      const i = await admin.req("POST", `/api/v1/admin/courses/${courseId}/draft/items/${itemId}`, {
        payload: {
          unitId,
          lexicalEntryId: entryId,
          meaning: "放弃",
          hint: "提示",
          draftVersion: version,
        },
      });
      expect(i.statusCode).toBe(201);
      version = (body(i) as { version?: number }).version ?? version;

      return { courseId, draftVersion: version, unitId, itemId, entryId };
    }

    async function publish(
      courseId: string,
      opts: { draftVersion: number; key: string; note?: string; token?: string },
    ): Promise<Res> {
      return admin.req("POST", `/api/v1/admin/courses/${courseId}/releases`, {
        headers: { "idempotency-key": opts.key },
        payload: {
          draftVersion: opts.draftVersion,
          ...(opts.note !== undefined ? { releaseNote: opts.note } : {}),
          ...(opts.token !== undefined ? { validationToken: opts.token } : {}),
        },
      });
    }

    async function learnerClient(): Promise<Client> {
      const username = `pub-learner-${randomBytes(3).toString("hex")}`;
      const res = await admin.req("POST", "/api/v1/admin/users", {
        headers: { "idempotency-key": `pub-create-${username}` },
        payload: {
          username,
          displayName: "发布测试学习者",
          timezone: "Asia/Shanghai",
          dailyBudgetMinutes: 10,
        },
      });
      expect(res.statusCode).toBe(201);
      const otp = (res.json() as { oneTimePassword?: string }).oneTimePassword;
      const client = makeClient(app);
      await client.req("POST", "/api/v1/auth/login", { payload: { username, password: otp } });
      await client.req("POST", "/api/v1/auth/change-password", {
        payload: { currentPassword: otp, newPassword: "pub-learner-pass-12345" },
      });
      return client;
    }

    it("发布有效草稿：创建 release 1、复制快照、设置 current pointer、写入审计", async () => {
      const { courseId, draftVersion, unitId, itemId } = await setupValidCourse();
      const res = await publish(courseId, { draftVersion, key: "pub-key-1", note: "首个版本" });
      expect(res.statusCode).toBe(201);
      const published = body(res) as {
        releaseId?: string;
        releaseNumber?: number;
        contentHash?: string;
        currentReleaseId?: string;
        createdAt?: string;
      };
      expect(published.releaseNumber).toBe(1);
      expect(published.releaseId).toBeTruthy();
      expect(published.contentHash).toBeTruthy();
      expect(published.currentReleaseId).toBe(published.releaseId);

      const pool = createPool({ ...config, max: 1 });
      try {
        const releases = await pool.query(
          "SELECT 1 FROM course_releases WHERE id = $1 AND release_number = 1 AND source_draft_version = $2",
          [published.releaseId, draftVersion],
        );
        expect(releases.rowCount).toBe(1);
        const units = await pool.query(
          "SELECT 1 FROM released_units WHERE release_id = $1 AND unit_id = $2 AND position = 1",
          [published.releaseId, unitId],
        );
        expect(units.rowCount).toBe(1);
        const items = await pool.query<{ english_spelling: string; meaning: string }>(
          `SELECT english_spelling, meaning FROM released_course_items
           WHERE release_id = $1 AND course_item_id = $2`,
          [published.releaseId, itemId],
        );
        expect(items.rowCount).toBe(1);
        expect(items.rows[0]?.english_spelling).toBeTruthy();
        expect(items.rows[0]?.meaning).toBe("放弃");

        const course = await pool.query<{ current_release_id: string | null }>(
          "SELECT current_release_id FROM courses WHERE id = $1",
          [courseId],
        );
        expect(course.rows[0]?.current_release_id).toBe(published.releaseId);

        const audit = await pool.query(
          "SELECT 1 FROM audit_events WHERE action = 'admin.course.release.create' AND target_id = $1",
          [courseId],
        );
        expect(audit.rowCount).toBe(1);
      } finally {
        await pool.end();
      }

      // 版本历史返回当前标记。
      const history = await admin.req("GET", `/api/v1/admin/courses/${courseId}/releases`, {});
      expect(history.statusCode).toBe(200);
      const items = (
        body(history) as {
          items: { releaseNumber: number; isCurrent: boolean; releaseNote: string }[];
        }
      ).items;
      expect(items[0]?.releaseNumber).toBe(1);
      expect(items[0]?.isCurrent).toBe(true);
      expect(items[0]?.releaseNote).toBe("首个版本");
    });

    it("幂等：同 key 同内容重试返回原结果，不产生第二个 release；同 key 改版本返回 409", async () => {
      const { courseId, draftVersion } = await setupValidCourse();
      const first = await publish(courseId, { draftVersion, key: "pub-idem" });
      expect(first.statusCode).toBe(201);
      const firstBody = body(first) as { releaseId?: string; releaseNumber?: number };

      const replay = await publish(courseId, { draftVersion, key: "pub-idem" });
      expect(replay.statusCode).toBe(201);
      const replayBody = body(replay) as { releaseId?: string; releaseNumber?: number };
      expect(replayBody.releaseId).toBe(firstBody.releaseId);
      expect(replayBody.releaseNumber).toBe(1);

      const pool = createPool({ ...config, max: 1 });
      try {
        const count = await pool.query("SELECT 1 FROM course_releases WHERE course_id = $1", [
          courseId,
        ]);
        expect(count.rowCount).toBe(1);
      } finally {
        await pool.end();
      }

      // 同 key 改 draftVersion → 409。
      const conflict = await publish(courseId, { draftVersion: 999, key: "pub-idem" });
      expect(conflict.statusCode).toBe(409);
      const err = body(conflict) as { error?: { code?: string } };
      expect(err.error?.code).toBe("CONFLICT");
    });

    it("过期 draftVersion → 409 DRAFT_VERSION_CONFLICT；阻断错误 → 422", async () => {
      const { courseId, draftVersion } = await setupValidCourse();
      const stale = await publish(courseId, { draftVersion: draftVersion - 1, key: uniq("stale") });
      expect(stale.statusCode).toBe(409);
      const err = body(stale) as { error?: { code?: string } };
      expect(err.error?.code).toBe("DRAFT_VERSION_CONFLICT");

      // 空课程（无单元）→ 发布 422。
      const slug = uniq("blocked");
      const res = await admin.req("POST", "/api/v1/admin/courses", {
        payload: { slug, title: "阻断课程" },
      });
      const courseId2 = (body(res) as { courseId?: string }).courseId as string;
      const blocked = await publish(courseId2, { draftVersion: 1, key: uniq("blocked") });
      expect(blocked.statusCode).toBe(422);
      const err2 = body(blocked) as { error?: { code?: string } };
      expect(err2.error?.code).toBe("VALIDATION_FAILED");
    });

    it("发布后修改草稿不改变已发布快照；重新发布为版本 2", async () => {
      const { courseId, draftVersion, itemId } = await setupValidCourse();
      await publish(courseId, { draftVersion, key: uniq("v1") });

      // 修改草稿释义并保存（版本递增）。
      const draft = await admin.req("GET", `/api/v1/admin/courses/${courseId}/draft`, {});
      const current = (body(draft) as { version?: number }).version ?? 0;
      await admin.req("PATCH", `/api/v1/admin/courses/${courseId}/draft`, {
        payload: { title: "发布后修改", draftVersion: current },
      });

      const pool = createPool({ ...config, max: 1 });
      try {
        // 已发布快照仍是旧标题。
        const old = await pool.query<{ title: string }>(
          `SELECT title FROM course_releases WHERE course_id = $1 AND release_number = 1`,
          [courseId],
        );
        expect(old.rows[0]?.title).toBe("发布课程");
        const oldItem = await pool.query<{ meaning: string }>(
          `SELECT meaning FROM released_course_items WHERE release_id = (
             SELECT id FROM course_releases WHERE course_id = $1 AND release_number = 1
           ) AND course_item_id = $2`,
          [courseId, itemId],
        );
        expect(oldItem.rows[0]?.meaning).toBe("放弃");
      } finally {
        await pool.end();
      }

      // 重新发布 → 版本 2。
      const d2 = await admin.req("GET", `/api/v1/admin/courses/${courseId}/draft`, {});
      const v2 = (body(d2) as { version?: number }).version ?? 0;
      const repub = await publish(courseId, { draftVersion: v2, key: uniq("v2") });
      expect(repub.statusCode).toBe(201);
      expect((body(repub) as { releaseNumber?: number }).releaseNumber).toBe(2);
    });

    it("并发发布（不同 key）不产生重复 release_number", async () => {
      const { courseId, draftVersion } = await setupValidCourse();
      const [r1, r2] = await Promise.all([
        publish(courseId, { draftVersion, key: uniq("conc-a") }),
        publish(courseId, { draftVersion, key: uniq("conc-b") }),
      ]);
      const numbers = [
        r1.statusCode === 201 ? (body(r1) as { releaseNumber?: number }).releaseNumber : 0,
        r2.statusCode === 201 ? (body(r2) as { releaseNumber?: number }).releaseNumber : 0,
      ];
      expect(numbers).toContain(1);
      expect(numbers).toContain(2);
      expect(numbers[0]).not.toBe(numbers[1]);
    });

    it("并发同 key 幂等：两个请求得到同一 releaseId，只生成一个版本，无 pending 假成功", async () => {
      const { courseId, draftVersion } = await setupValidCourse();
      const key = uniq("same-key");
      const [r1, r2] = await Promise.all([
        publish(courseId, { draftVersion, key }),
        publish(courseId, { draftVersion, key }),
      ]);
      expect(r1.statusCode).toBe(201);
      expect(r2.statusCode).toBe(201);
      const b1 = body(r1) as { releaseId?: string; releaseNumber?: number; pending?: boolean };
      const b2 = body(r2) as { releaseId?: string; releaseNumber?: number; pending?: boolean };
      expect(b1.releaseId).toBeTruthy();
      expect(b2.releaseId).toBe(b1.releaseId);
      expect(b2.releaseNumber).toBe(b1.releaseNumber);
      // 不能把 pending 当作成功响应返回。
      expect(b1.pending).toBeUndefined();
      expect(b2.pending).toBeUndefined();

      const pool = createPool({ ...config, max: 1 });
      try {
        const count = await pool.query("SELECT 1 FROM course_releases WHERE course_id = $1", [
          courseId,
        ]);
        expect(count.rowCount).toBe(1);
      } finally {
        await pool.end();
      }
    });

    it("幂等恢复唯一：同 draftVersion 两个 key 发布两个版本，重试第一个 key 不返回第二个 release，currentReleaseId 用真实指针", async () => {
      const { courseId, draftVersion } = await setupValidCourse();
      const keyA = uniq("recover-a");
      const keyB = uniq("recover-b");

      const a = await publish(courseId, { draftVersion, key: keyA, note: "A" });
      expect(a.statusCode).toBe(201);
      const aBody = body(a) as { releaseId?: string; releaseNumber?: number };

      const b = await publish(courseId, { draftVersion, key: keyB, note: "B" });
      expect(b.statusCode).toBe(201);
      const bBody = body(b) as { releaseId?: string; releaseNumber?: number };
      expect(bBody.releaseId).not.toBe(aBody.releaseId);

      const pool = createPool({ ...config, max: 1 });
      try {
        // 把 keyA 的响应模拟为 pending（resource_id 保留，仍指向 release A）。
        await pool.query(
          `UPDATE idempotency_keys SET response_json = '{"pending":true}' WHERE scope = $1 AND key = $2`,
          [`admin:publish-release:${courseId}`, keyA],
        );
        const row = await pool.query<{ resource_id: string | null }>(
          `SELECT resource_id FROM idempotency_keys WHERE scope = $1 AND key = $2`,
          [`admin:publish-release:${courseId}`, keyA],
        );
        expect(row.rows[0]?.resource_id).toBe(aBody.releaseId);
      } finally {
        await pool.end();
      }

      // 重试 keyA（相同请求内容）→ 必须恢复 release A，而不是同草稿版本的 release B。
      const retry = await publish(courseId, { draftVersion, key: keyA, note: "A" });
      expect(retry.statusCode).toBe(201);
      const retryBody = body(retry) as {
        releaseId?: string;
        releaseNumber?: number;
        currentReleaseId?: string;
        pending?: boolean;
      };
      expect(retryBody.pending).toBeUndefined();
      expect(retryBody.releaseId).toBe(aBody.releaseId);
      expect(retryBody.releaseNumber).toBe(1);
      // 当前指针在 B（第二次发布后指针指向 B）。
      expect(retryBody.currentReleaseId).toBe(bBody.releaseId);

      // 把 current pointer 切回 A，再恢复 → currentReleaseId 反映真实指针 A。
      const move = await admin.req("PUT", `/api/v1/admin/courses/${courseId}/current-release`, {
        payload: { releaseId: aBody.releaseId },
      });
      expect(move.statusCode).toBe(200);
      const retry2 = await publish(courseId, { draftVersion, key: keyA, note: "A" });
      const retry2Body = body(retry2) as { currentReleaseId?: string };
      expect(retry2Body.currentReleaseId).toBe(aBody.releaseId);

      // 不能生成额外 release。
      const pool2 = createPool({ ...config, max: 1 });
      try {
        const count = await pool2.query("SELECT 1 FROM course_releases WHERE course_id = $1", [
          courseId,
        ]);
        expect(count.rowCount).toBe(2);
      } finally {
        await pool2.end();
      }
    }, 20000);

    it("release rows 禁止 UPDATE/DELETE；跨课程 current pointer 拒绝", async () => {
      const { courseId, draftVersion } = await setupValidCourse();
      const pub = await publish(courseId, { draftVersion, key: uniq("immut") });
      const releaseId = (body(pub) as { releaseId?: string }).releaseId as string;

      const pool = createPool({ ...config, max: 1 });
      try {
        await expect(
          pool.query("UPDATE course_releases SET title = '篡改' WHERE id = $1", [releaseId]),
        ).rejects.toThrow(/immutable/);
        await expect(
          pool.query("DELETE FROM course_releases WHERE id = $1", [releaseId]),
        ).rejects.toThrow(/immutable/);
        await expect(
          pool.query("UPDATE released_units SET title = '篡改' WHERE release_id = $1", [releaseId]),
        ).rejects.toThrow(/immutable/);
      } finally {
        await pool.end();
      }

      // 跨课程 release 不能作为当前版本。
      const { courseId: otherId, draftVersion: otherV } = await setupValidCourse();
      const otherPub = await publish(otherId, { draftVersion: otherV, key: uniq("other") });
      const otherReleaseId = (body(otherPub) as { releaseId?: string }).releaseId as string;

      const cross = await admin.req("PUT", `/api/v1/admin/courses/${courseId}/current-release`, {
        payload: { releaseId: otherReleaseId },
      });
      expect(cross.statusCode).toBe(409);
    });

    it("current pointer 切换只改指针，不改快照；learner 拒绝发布接口", async () => {
      const { courseId, draftVersion } = await setupValidCourse();
      await publish(courseId, { draftVersion, key: uniq("p1") });
      const d2 = await admin.req("GET", `/api/v1/admin/courses/${courseId}/draft`, {});
      const v2 = (body(d2) as { version?: number }).version ?? 0;
      const p2 = await publish(courseId, { draftVersion: v2, key: uniq("p2") });
      expect(p2.statusCode).toBe(201);
      const release1 = (
        body(await admin.req("GET", `/api/v1/admin/courses/${courseId}/releases`, {})) as {
          items: { id: string; releaseNumber: number }[];
        }
      ).items.find((r) => r.releaseNumber === 1)?.id as string;

      // 切回版本 1。
      const move = await admin.req("PUT", `/api/v1/admin/courses/${courseId}/current-release`, {
        payload: { releaseId: release1 },
      });
      expect(move.statusCode).toBe(200);

      const pool = createPool({ ...config, max: 1 });
      try {
        const course = await pool.query<{ current_release_id: string | null }>(
          "SELECT current_release_id FROM courses WHERE id = $1",
          [courseId],
        );
        expect(course.rows[0]?.current_release_id).toBe(release1);
        // release rows 未改变。
        const count = await pool.query("SELECT 1 FROM course_releases WHERE course_id = $1", [
          courseId,
        ]);
        expect(count.rowCount).toBe(2);
        const audit = await pool.query(
          "SELECT 1 FROM audit_events WHERE action = 'admin.course.current_release.change' AND target_id = $1",
          [courseId],
        );
        expect(audit.rowCount).toBe(1);
      } finally {
        await pool.end();
      }

      // learner 拒绝发布。
      const learner = await learnerClient();
      const denied = await learner.req("POST", `/api/v1/admin/courses/${courseId}/releases`, {
        headers: { "idempotency-key": "learner-pub" },
        payload: { draftVersion: v2 },
      });
      expect(denied.statusCode).toBe(403);
    });
  },
);
