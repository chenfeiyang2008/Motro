// 学习者报名与主课程集成测试：首次报名、重复报名幂等、设主/切换、
// 并发切换唯一主课程、用户隔离、软停用、不可见课程、release 指针变化、
// 无学习产物与 CSRF。需要运行中的 PostgreSQL（compose db）。
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

describe.skipIf(!dbAvailable && process.env.MOTRO_REQUIRE_DB !== "1")(
  "learner enrollment & primary course",
  () => {
    let app: App;
    let admin: Client;
    let learner: Client;
    let otherLearner: Client;
    let learnerUserId: string;
    let otherUserId: string;

    beforeAll(async () => {
      await migrate(config, MIGRATIONS_DIR);
      const ps = new PasswordService();
      const seedPool = createPool({ ...config, max: 1 });
      const adminHash = await ps.hashPassword("enroll-itest-admin-pass-123");
      await seedPool.query(
        `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ('enroll-itest-admin', 'Enroll ITest Admin', 'admin', 'active', 'Asia/Shanghai', 10, $1, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $1, must_change_password = false, status = 'active'`,
        [adminHash],
      );
      const learnerHash = await ps.hashPassword("enroll-itest-learner-pass-123");
      const learnerInsert = await seedPool.query<{ id: string }>(
        `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ('enroll-itest-learner', 'Enroll ITest Learner', 'learner', 'active', 'Asia/Shanghai', 10, $1, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $1, must_change_password = false, status = 'active'
       RETURNING id`,
        [learnerHash],
      );
      learnerUserId = learnerInsert.rows[0]?.id as string;
      const otherHash = await ps.hashPassword("enroll-itest-other-pass-123");
      const otherInsert = await seedPool.query<{ id: string }>(
        `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ('enroll-itest-other', 'Enroll ITest Other', 'learner', 'active', 'Asia/Shanghai', 10, $1, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $1, must_change_password = false, status = 'active'
       RETURNING id`,
        [otherHash],
      );
      otherUserId = otherInsert.rows[0]?.id as string;
      // 清空历史运行遗留的报名，保证每个测试会话从干净状态开始。
      await seedPool.query(`DELETE FROM course_enrollments WHERE user_id IN ($1, $2)`, [
        learnerUserId,
        otherUserId,
      ]);
      await seedPool.end();

      app = await createApp();
      await app.init();
      admin = makeClient(app);
      const alogin = await admin.req("POST", "/api/v1/auth/login", {
        payload: { username: "enroll-itest-admin", password: "enroll-itest-admin-pass-123" },
      });
      expect(alogin.statusCode).toBe(200);

      learner = makeClient(app);
      const llogin = await learner.req("POST", "/api/v1/auth/login", {
        payload: { username: "enroll-itest-learner", password: "enroll-itest-learner-pass-123" },
      });
      expect(llogin.statusCode).toBe(200);

      otherLearner = makeClient(app);
      const ologin = await otherLearner.req("POST", "/api/v1/auth/login", {
        payload: { username: "enroll-itest-other", password: "enroll-itest-other-pass-123" },
      });
      expect(ologin.statusCode).toBe(200);
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

    /** 管理员创建课程 + 单元 + 词项并发布；返回稳定 ID。 */
    async function createPublishedCourse(opts?: { title?: string }): Promise<{
      courseId: string;
      unitId: string;
      itemId: string;
      releaseNumber: number;
    }> {
      const entryRes = await admin.req("POST", "/api/v1/admin/lexical-entries", {
        payload: { canonicalSpelling: uniq("enrword"), confirmDuplicate: false },
      });
      expect(entryRes.statusCode).toBe(201);
      const entryId = (body(entryRes) as { id?: string }).id as string;

      const slug = uniq("enrcourse");
      const res = await admin.req("POST", "/api/v1/admin/courses", {
        payload: { slug, title: opts?.title ?? "报名课程", level: "a1", description: "课程描述" },
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
        payload: { unitId, lexicalEntryId: entryId, meaning: "放弃", draftVersion: version },
      });
      expect(i.statusCode).toBe(201);
      version = (body(i) as { version?: number }).version ?? version;

      const pub = await admin.req("POST", `/api/v1/admin/courses/${courseId}/releases`, {
        headers: { "idempotency-key": uniq("enrpub") },
        payload: { draftVersion: version, releaseNote: "发布" },
      });
      expect(pub.statusCode).toBe(201);
      return {
        courseId,
        unitId,
        itemId,
        releaseNumber: (body(pub) as { releaseNumber?: number }).releaseNumber ?? 1,
      };
    }

    /** 直接读取某用户的 active primary 报名数量（DB 断言）。 */
    async function countActivePrimary(userId: string): Promise<number> {
      const pool = createPool({ ...config, max: 1 });
      try {
        const res = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM course_enrollments
         WHERE user_id = $1 AND active = true AND is_primary = true`,
          [userId],
        );
        return Number(res.rows[0]?.n ?? 0);
      } finally {
        await pool.end();
      }
    }

    /** 直接读取某用户的报名行数。 */
    async function countEnrollments(userId: string): Promise<number> {
      const pool = createPool({ ...config, max: 1 });
      try {
        const res = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM course_enrollments WHERE user_id = $1`,
          [userId],
        );
        return Number(res.rows[0]?.n ?? 0);
      } finally {
        await pool.end();
      }
    }

    it("首次报名返回已报名、非主课程；列表与详情读取一致", async () => {
      const { courseId } = await createPublishedCourse({ title: "首报课程" });

      const enroll = await learner.req("POST", `/api/v1/catalog/courses/${courseId}/enroll`, {
        payload: { makePrimary: false },
      });
      expect(enroll.statusCode).toBe(200);
      const detail = body(enroll) as { courseId: string; isEnrolled: boolean; isPrimary: boolean };
      expect(detail.courseId).toBe(courseId);
      expect(detail.isEnrolled).toBe(true);
      expect(detail.isPrimary).toBe(false);

      // 列表读取一致。
      const list = await learner.req("GET", "/api/v1/catalog/courses", {});
      const item = (
        body(list) as { items: { courseId: string; isEnrolled: boolean; isPrimary: boolean }[] }
      ).items.find((c) => c.courseId === courseId);
      expect(item?.isEnrolled).toBe(true);
      expect(item?.isPrimary).toBe(false);

      // DB 恰好一行报名。
      expect(await countEnrollments(learnerUserId)).toBe(1);
    });

    it("重复报名幂等：不重复建行，返回相同状态", async () => {
      const { courseId } = await createPublishedCourse({ title: "幂等课程" });
      await learner.req("POST", `/api/v1/catalog/courses/${courseId}/enroll`, {
        payload: { makePrimary: true },
      });
      const before = await countEnrollments(learnerUserId);

      const again = await learner.req("POST", `/api/v1/catalog/courses/${courseId}/enroll`, {
        payload: { makePrimary: false },
      });
      expect(again.statusCode).toBe(200);
      const detail = body(again) as { isEnrolled: boolean; isPrimary: boolean };
      // 重复报名不降级既有主课程状态。
      expect(detail.isEnrolled).toBe(true);
      expect(detail.isPrimary).toBe(true);

      // 行数不变，无重复报名行。
      expect(await countEnrollments(learnerUserId)).toBe(before);
    });

    it("报名并设主；切换后旧课程保留报名但失去主课程标记", async () => {
      const first = await createPublishedCourse({ title: "第一门" });
      const second = await createPublishedCourse({ title: "第二门" });

      await learner.req("POST", `/api/v1/catalog/courses/${first.courseId}/enroll`, {
        payload: { makePrimary: true },
      });
      await learner.req("POST", `/api/v1/catalog/courses/${second.courseId}/enroll`, {
        payload: { makePrimary: false },
      });

      const beforeSwitch = await learner.req(
        "GET",
        `/api/v1/catalog/courses/${first.courseId}`,
        {},
      );
      expect((body(beforeSwitch) as { isPrimary: boolean }).isPrimary).toBe(true);

      // 切到第二门：旧主课程保留报名（isEnrolled 仍 true），只有新课程为主。
      const switched = await learner.req("PUT", "/api/v1/catalog/primary-course", {
        payload: { courseId: second.courseId },
      });
      expect(switched.statusCode).toBe(200);
      const secondDetail = body(switched) as { isEnrolled: boolean; isPrimary: boolean };
      expect(secondDetail.isEnrolled).toBe(true);
      expect(secondDetail.isPrimary).toBe(true);

      const firstAfter = await learner.req("GET", `/api/v1/catalog/courses/${first.courseId}`, {});
      const firstDetail = body(firstAfter) as { isEnrolled: boolean; isPrimary: boolean };
      expect(firstDetail.isEnrolled).toBe(true);
      expect(firstDetail.isPrimary).toBe(false);

      // DB 恰好一个 active primary。
      expect(await countActivePrimary(learnerUserId)).toBe(1);
    });

    it("未报名课程设主 → 409；无 current release/不可见课程报名或设主 → 404", async () => {
      const { courseId } = await createPublishedCourse({ title: "未报名课程" });

      const notEnrolled = await learner.req("PUT", "/api/v1/catalog/primary-course", {
        payload: { courseId },
      });
      expect(notEnrolled.statusCode).toBe(409);

      // 有草稿但未发布（无 current release）→ 报名 404、设主 404。
      const slug = uniq("unpublished-enroll");
      const created = await admin.req("POST", "/api/v1/admin/courses", {
        payload: { slug, title: "未发布课程" },
      });
      const draftCourseId = (body(created) as { courseId?: string }).courseId as string;
      const enrollHidden = await learner.req(
        "POST",
        `/api/v1/catalog/courses/${draftCourseId}/enroll`,
        { payload: { makePrimary: false } },
      );
      expect(enrollHidden.statusCode).toBe(404);
      const primaryHidden = await learner.req("PUT", "/api/v1/catalog/primary-course", {
        payload: { courseId: draftCourseId },
      });
      expect(primaryHidden.statusCode).toBe(404);
    });

    it("并发报名并设主与并发切换：最终恰好一个主课程", async () => {
      const courses: { courseId: string }[] = [];
      for (let n = 0; n < 3; n++) {
        courses.push(await createPublishedCourse({ title: `并发课程 ${n}` }));
      }

      // 三个并发 enroll(makePrimary=true)：advisory 锁串行化，全部成功且最终一个 primary。
      const enrollResults = await Promise.all(
        courses.map((c) =>
          learner.req("POST", `/api/v1/catalog/courses/${c.courseId}/enroll`, {
            payload: { makePrimary: true },
          }),
        ),
      );
      expect(enrollResults.every((r) => r.statusCode === 200)).toBe(true);
      expect(await countActivePrimary(learnerUserId)).toBe(1);

      // 三个并发切换：最终仍恰好一个 primary。
      const switchResults = await Promise.all(
        courses.map((c) =>
          learner.req("PUT", "/api/v1/catalog/primary-course", {
            payload: { courseId: c.courseId },
          }),
        ),
      );
      expect(switchResults.every((r) => r.statusCode === 200)).toBe(true);
      expect(await countActivePrimary(learnerUserId)).toBe(1);

      // 列表层面只有一门课程显示为主课程。
      const list = await learner.req("GET", "/api/v1/catalog/courses", {});
      const primaries = (
        body(list) as { items: { courseId: string; isPrimary: boolean }[] }
      ).items.filter((c) => c.isPrimary);
      expect(primaries).toHaveLength(1);
    });

    it("数据库 partial unique index 是并发防线：直接插入第二个 active primary 被拒绝", async () => {
      const a = await createPublishedCourse({ title: "索引课程A" });
      const b = await createPublishedCourse({ title: "索引课程B" });
      const pool = createPool({ ...config, max: 1 });
      try {
        // 清空该用户现有报名，从干净状态验证唯一索引本身。
        await pool.query(`DELETE FROM course_enrollments WHERE user_id = $1`, [learnerUserId]);
        await pool.query(
          `INSERT INTO course_enrollments (user_id, course_id, active, is_primary)
         VALUES ($1, $2, true, true)`,
          [learnerUserId, a.courseId],
        );
        await expect(
          pool.query(
            `INSERT INTO course_enrollments (user_id, course_id, active, is_primary)
           VALUES ($1, $2, true, true)`,
            [learnerUserId, b.courseId],
          ),
        ).rejects.toMatchObject({ code: "23505" });
      } finally {
        await pool.end();
      }
    });

    it("软停用报名视为未报名；重新报名重新激活同一行", async () => {
      const { courseId } = await createPublishedCourse({ title: "软停用课程" });
      await learner.req("POST", `/api/v1/catalog/courses/${courseId}/enroll`, {
        payload: { makePrimary: true },
      });
      expect(await countActivePrimary(learnerUserId)).toBe(1);

      const pool = createPool({ ...config, max: 1 });
      try {
        await pool.query(
          `UPDATE course_enrollments SET active = false, is_primary = false, updated_at = now()
         WHERE user_id = $1 AND course_id = $2`,
          [learnerUserId, courseId],
        );
      } finally {
        await pool.end();
      }

      // 软停用后 API 视为未报名。
      const afterDisable = await learner.req("GET", `/api/v1/catalog/courses/${courseId}`, {});
      const d = body(afterDisable) as { isEnrolled: boolean; isPrimary: boolean };
      expect(d.isEnrolled).toBe(false);
      expect(d.isPrimary).toBe(false);

      // 重新报名重新激活同一行（行数不变，不重复建行）。
      const rowsBefore = await countEnrollments(learnerUserId);
      const reenroll = await learner.req("POST", `/api/v1/catalog/courses/${courseId}/enroll`, {
        payload: { makePrimary: true },
      });
      expect(reenroll.statusCode).toBe(200);
      const re = body(reenroll) as { isEnrolled: boolean; isPrimary: boolean };
      expect(re.isEnrolled).toBe(true);
      expect(re.isPrimary).toBe(true);
      expect(await countEnrollments(learnerUserId)).toBe(rowsBefore);
      expect(await countActivePrimary(learnerUserId)).toBe(1);
    });

    it("用户隔离：他人报名/主课程不污染当前用户；admin 通过 learner API 只作用于自己", async () => {
      const { courseId } = await createPublishedCourse({ title: "隔离课程" });

      // otherLearner 报名并设主。
      await otherLearner.req("POST", `/api/v1/catalog/courses/${courseId}/enroll`, {
        payload: { makePrimary: true },
      });
      // learner 视角：该课程仍未报名、非主课程。
      const learnerView = await learner.req("GET", `/api/v1/catalog/courses/${courseId}`, {});
      const ld = body(learnerView) as { isEnrolled: boolean; isPrimary: boolean };
      expect(ld.isEnrolled).toBe(false);
      expect(ld.isPrimary).toBe(false);

      // admin 通过 learner API 报名只作用于 admin 自己，不影响 learner。
      await admin.req("POST", `/api/v1/catalog/courses/${courseId}/enroll`, {
        payload: { makePrimary: true },
      });
      const learnerAfter = await learner.req("GET", `/api/v1/catalog/courses/${courseId}`, {});
      expect((body(learnerAfter) as { isEnrolled: boolean }).isEnrolled).toBe(false);

      // DB：otherLearner 与 learner 各恰好一个 primary，互不干扰。
      expect(await countActivePrimary(otherUserId)).toBe(1);
      expect(await countActivePrimary(learnerUserId)).toBe(1);
    });

    it("release 指针变化不改变报名关系；详情返回新 current release 但保留 isEnrolled", async () => {
      const { courseId } = await createPublishedCourse({ title: "指针课程" });
      await learner.req("POST", `/api/v1/catalog/courses/${courseId}/enroll`, {
        payload: { makePrimary: true },
      });

      // 修改草稿并重新发布（版本 2）。
      const draft = await admin.req("GET", `/api/v1/admin/courses/${courseId}/draft`, {});
      let version = (body(draft) as { version?: number }).version ?? 0;
      version += 1;
      await admin.req("PATCH", `/api/v1/admin/courses/${courseId}/draft`, {
        payload: { title: "指针课程 v2", draftVersion: version - 1 },
      });
      const pub2 = await admin.req("POST", `/api/v1/admin/courses/${courseId}/releases`, {
        headers: { "idempotency-key": uniq("enrpub2") },
        payload: { draftVersion: version, releaseNote: "版本二" },
      });
      expect(pub2.statusCode).toBe(201);

      const detail = await learner.req("GET", `/api/v1/catalog/courses/${courseId}`, {});
      const d = body(detail) as { releaseNumber: number; isEnrolled: boolean; isPrimary: boolean };
      expect(d.releaseNumber).toBe(2);
      expect(d.isEnrolled).toBe(true);
      expect(d.isPrimary).toBe(true);
    });

    it("报名/设主不创建学习产物（learning_cards 表存在但不产生行；review_events/xp 无表）", async () => {
      const pool = createPool({ ...config, max: 1 });
      try {
        // 阶段 5 已引入 learning_cards/learning_exposures；复习/XP/每日计划表仍不存在。
        const tables = await pool.query<{ tablename: string }>(
          `SELECT tablename FROM pg_tables
         WHERE schemaname = 'public' AND tablename IN ('review_events','xp_entries','daily_plans')`,
        );
        expect(tables.rows).toEqual([]);
      } finally {
        await pool.end();
      }

      const { courseId } = await createPublishedCourse({ title: "无学习产物课程" });
      const enroll = await learner.req("POST", `/api/v1/catalog/courses/${courseId}/enroll`, {
        payload: { makePrimary: true },
      });
      // 响应只有目录 DTO，不携带任何学习进度/会话数据。
      const d = body(enroll) as Record<string, unknown>;
      expect(d).not.toHaveProperty("sessionId");
      expect(d).not.toHaveProperty("learningCardCount");
      expect(d).not.toHaveProperty("xp");

      // 报名/设主不产生学习卡行（卡由学习接口按需同步）。
      const pool2 = createPool({ ...config, max: 1 });
      try {
        const cards = await pool2.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM learning_cards
           WHERE user_id = $1 AND course_id = $2`,
          [learnerUserId, courseId],
        );
        expect(Number(cards.rows[0]?.n ?? 0)).toBe(0);
      } finally {
        await pool2.end();
      }
    });

    it("不安全方法缺少 CSRF 头 → 403", async () => {
      const { courseId } = await createPublishedCourse({ title: "CSRF 课程" });

      /** 从 set-cookie 头提取指定 cookie 值；无则返回空串。 */
      const extractCookie = (header: string | string[] | undefined, name: string): string => {
        const lines = Array.isArray(header) ? header : header ? [header] : [];
        for (const line of lines) {
          const pair = line.split(";")[0];
          if (pair && pair.startsWith(`${name}=`)) return pair.slice(name.length + 1);
        }
        return "";
      };

      // 手工登录获取会话 cookie，但故意不带 x-csrf-token。
      const warm = await app.inject({ method: "GET", url: "/api/v1/health/live" });
      const csrf = extractCookie(warm.headers["set-cookie"], "motro_csrf");
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { "x-csrf-token": csrf, cookie: `motro_csrf=${csrf}` },
        payload: { username: "enroll-itest-learner", password: "enroll-itest-learner-pass-123" },
      });
      expect(login.statusCode).toBe(200);
      const session = extractCookie(login.headers["set-cookie"], "motro_session");

      const noCsrf = await app.inject({
        method: "POST",
        url: `/api/v1/catalog/courses/${courseId}/enroll`,
        headers: { cookie: `${session}; motro_csrf=${csrf}` },
        payload: { makePrimary: false },
      });
      expect(noCsrf.statusCode).toBe(403);

      // 未登录访问 learner API → 401。
      const anon = await app.inject({ method: "GET", url: "/api/v1/catalog/courses" });
      expect(anon.statusCode).toBe(401);
    });
  },
);
