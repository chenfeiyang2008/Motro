// 学习者目录集成测试：只读 current release、隐藏资源 404、不可见课程、指针切换、
// 草稿修改不影响 learner 响应、角色与越权检查。
// 需要运行中的 PostgreSQL（compose 的 db 服务）。连接不可用时整个 describe 跳过。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createPool, loadDbConfigFromEnv, migrate } from "@motro/db";
import { createApp } from "../../../../apps/api/src/bootstrap-app.js";
import { PasswordService } from "../../../../apps/api/src/auth/password.service.js";
import { closeAppDbPools, dropIsolatedDatabase } from "../isolated-db.helper.js";

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

interface PublishedCourse {
  courseId: string;
  unitId: string;
  itemId: string;
  releaseNumber: number;
}

describe.skipIf(!dbAvailable && process.env.MOTRO_REQUIRE_DB !== "1")("learner catalog", () => {
  let app: App;
  let admin: Client;
  let learner: Client;
  let isolatedDbName: string | undefined;
  const previousDb = process.env.POSTGRES_DB;

  beforeAll(async () => {
    // 一次性隔离库，避免共享开发库已累积海量已发布课程导致分页断言不稳定。
    isolatedDbName = `motro_catalog_read_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
    const adminPool = createPool({ ...config, database: "postgres", max: 1 });
    try {
      await adminPool.query(`CREATE DATABASE "${isolatedDbName}"`);
    } finally {
      await adminPool.end();
    }
    const isolatedConfig = { ...config, database: isolatedDbName };
    await migrate(isolatedConfig, MIGRATIONS_DIR);
    // 让 createApp / @motro/config 与本测试池都指向隔离库。
    process.env.POSTGRES_DB = isolatedDbName;
    const adminPool2 = createPool({ ...isolatedConfig, max: 1 });
    const ps = new PasswordService();
    const hash = await ps.hashPassword("catalog-itest-admin-pass-123");
    await adminPool2.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ('catalog-itest-admin', 'Catalog ITest Admin', 'admin', 'active', 'Asia/Shanghai', 10, $1, false)`,
      [hash],
    );
    const learnerHash = await ps.hashPassword("catalog-itest-learner-pass-123");
    await adminPool2.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ('catalog-itest-learner', 'Catalog ITest Learner', 'learner', 'active', 'Asia/Shanghai', 10, $1, false)`,
      [learnerHash],
    );
    await adminPool2.end();

    app = await createApp();
    await app.init();
    admin = makeClient(app);
    const login = await admin.req("POST", "/api/v1/auth/login", {
      payload: { username: "catalog-itest-admin", password: "catalog-itest-admin-pass-123" },
    });
    expect(login.statusCode).toBe(200);

    learner = makeClient(app);
    const llogin = await learner.req("POST", "/api/v1/auth/login", {
      payload: { username: "catalog-itest-learner", password: "catalog-itest-learner-pass-123" },
    });
    expect(llogin.statusCode).toBe(200);
  });

  afterAll(async () => {
    try {
      if (app) {
        // 先显式 end 各模块池/health 池，再 close，避免 DROP 隔离库时强杀待释放连接（57P01）。
        await closeAppDbPools(app);
        await app.close();
      }
    } finally {
      if (previousDb === undefined) delete process.env.POSTGRES_DB;
      else process.env.POSTGRES_DB = previousDb;
      if (isolatedDbName) {
        await dropIsolatedDatabase(isolatedDbName);
      }
    }
  });

  function body(res: Res): Record<string, unknown> {
    return res.json() as Record<string, unknown>;
  }

  function uniq(prefix: string): string {
    return `${prefix}-${randomBytes(4).toString("hex")}`;
  }

  /** 管理员创建课程 + 单元 + 词项，并发布。 */
  async function createPublishedCourse(opts?: { unitTitle?: string }): Promise<PublishedCourse> {
    const entryRes = await admin.req("POST", "/api/v1/admin/lexical-entries", {
      payload: { canonicalSpelling: uniq("catword"), confirmDuplicate: false },
    });
    expect(entryRes.statusCode).toBe(201);
    const entryId = (body(entryRes) as { id?: string }).id as string;

    const slug = uniq("catcourse");
    const res = await admin.req("POST", "/api/v1/admin/courses", {
      payload: { slug, title: "目录课程", level: "a1", description: "课程描述" },
    });
    expect(res.statusCode).toBe(201);
    const created = body(res) as { courseId?: string; draftVersion?: number };
    const courseId = created.courseId as string;
    let version = created.draftVersion ?? 1;

    const unitId = randomUUID();
    const u = await admin.req("POST", `/api/v1/admin/courses/${courseId}/draft/units/${unitId}`, {
      payload: {
        title: opts?.unitTitle ?? "基础词汇",
        description: "单元描述",
        draftVersion: version,
      },
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
      headers: { "idempotency-key": uniq("catpub") },
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

  it("学习者列表只返回可见课程及其 current release，单元有序、未开始", async () => {
    const { courseId, unitId, releaseNumber } = await createPublishedCourse();

    const list = await learner.req("GET", "/api/v1/catalog/courses", {});
    expect(list.statusCode).toBe(200);
    const items = (
      body(list) as {
        items: {
          courseId: string;
          title: string;
          releaseNumber: number;
          contentSource: string;
          progressStatus: string;
        }[];
      }
    ).items;
    const item = items.find((c) => c.courseId === courseId);
    expect(item).toBeTruthy();
    expect(item?.releaseNumber).toBe(releaseNumber);
    expect(item?.contentSource).toBe("published_release");
    expect(item?.progressStatus).toBe("not_started");

    const detail = await learner.req("GET", `/api/v1/catalog/courses/${courseId}`, {});
    expect(detail.statusCode).toBe(200);
    const d = body(detail) as {
      title: string;
      level: string;
      releaseNumber: number;
      contentSource: string;
      progressStatus: string;
      units: { unitId: string; position: number; title: string }[];
    };
    expect(d.title).toBe("目录课程");
    expect(d.releaseNumber).toBe(releaseNumber);
    expect(d.contentSource).toBe("published_release");
    expect(d.progressStatus).toBe("not_started");
    expect(d.units.map((u) => u.unitId)).toEqual([unitId]);
    expect(d.units[0]?.position).toBe(1);
    expect(d.units[0]?.title).toBe("基础词汇");
  });

  it("无 current release / 不可见 / 不存在课程 → 隐藏资源 404", async () => {
    // 未发布的课程（无 current release）不出现在列表，详情 404。
    const slug = uniq("unpublished");
    const res = await admin.req("POST", "/api/v1/admin/courses", {
      payload: { slug, title: "未发布课程" },
    });
    const courseId = (body(res) as { courseId?: string }).courseId as string;
    const notInList = await learner.req("GET", "/api/v1/catalog/courses", {});
    expect(
      (body(notInList) as { items: { courseId: string }[] }).items.some(
        (c) => c.courseId === courseId,
      ),
    ).toBe(false);
    const hidden = await learner.req("GET", `/api/v1/catalog/courses/${courseId}`, {});
    expect(hidden.statusCode).toBe(404);

    // 不可见课程（visibility 非 published）详情 404。
    const pub = await createPublishedCourse();
    // 用当前环境（已指向隔离库）的连接更新可见性。
    const pool = createPool({ ...loadDbConfigFromEnv(), max: 1 });
    try {
      await pool.query(`UPDATE courses SET visibility = 'archived' WHERE id = $1`, [pub.courseId]);
    } finally {
      await pool.end();
    }
    const archived = await learner.req("GET", `/api/v1/catalog/courses/${pub.courseId}`, {});
    expect(archived.statusCode).toBe(404);

    // 不存在课程 404。
    const missing = await learner.req(
      "GET",
      "/api/v1/catalog/courses/00000000-0000-0000-0000-000000000000",
      {},
    );
    expect(missing.statusCode).toBe(404);
  });

  it("修改草稿不影响 learner 响应；指针切换后读取新 current release", async () => {
    const { courseId } = await createPublishedCourse({ unitTitle: "原始单元" });
    const before = await learner.req("GET", `/api/v1/catalog/courses/${courseId}`, {});
    expect((body(before) as { units: { title: string }[] }).units[0]?.title).toBe("原始单元");

    // 修改草稿单元标题并保存（不发布）。
    const draft = await admin.req("GET", `/api/v1/admin/courses/${courseId}/draft`, {});
    const version = (body(draft) as { version?: number }).version ?? 0;
    const unitId = (body(draft) as { units: { id: string }[] }).units[0]?.id as string;
    await admin.req("PATCH", `/api/v1/admin/courses/${courseId}/draft/units/${unitId}`, {
      payload: { title: "草稿修改后的单元", draftVersion: version },
    });

    // learner 响应仍显示旧快照。
    const after = await learner.req("GET", `/api/v1/catalog/courses/${courseId}`, {});
    expect((body(after) as { units: { title: string }[] }).units[0]?.title).toBe("原始单元");

    // 重新发布（版本 2）→ learner 读取新 current release。
    const draft2 = await admin.req("GET", `/api/v1/admin/courses/${courseId}/draft`, {});
    const version2 = (body(draft2) as { version?: number }).version ?? 0;
    const pub2 = await admin.req("POST", `/api/v1/admin/courses/${courseId}/releases`, {
      headers: { "idempotency-key": uniq("catpub2") },
      payload: { draftVersion: version2, releaseNote: "版本二" },
    });
    expect(pub2.statusCode).toBe(201);
    const after2 = await learner.req("GET", `/api/v1/catalog/courses/${courseId}`, {});
    const detail2 = body(after2) as { releaseNumber: number; units: { title: string }[] };
    expect(detail2.releaseNumber).toBe(2);
    expect(detail2.units[0]?.title).toBe("草稿修改后的单元");

    // 把 current pointer 切回版本 1 → learner 读取版本 1。
    const releases = await admin.req("GET", `/api/v1/admin/courses/${courseId}/releases`, {});
    const release1 = (
      body(releases) as { items: { id: string; releaseNumber: number }[] }
    ).items.find((r) => r.releaseNumber === 1)?.id as string;
    await admin.req("PUT", `/api/v1/admin/courses/${courseId}/current-release`, {
      payload: { releaseId: release1 },
    });
    const after3 = await learner.req("GET", `/api/v1/catalog/courses/${courseId}`, {});
    const detail3 = body(after3) as { releaseNumber: number; units: { title: string }[] };
    expect(detail3.releaseNumber).toBe(1);
    expect(detail3.units[0]?.title).toBe("原始单元");
  });

  it("未登录拒绝；admin 访问 learner API 只得到 learner 结果；learner 不能访问 admin draft API", async () => {
    const anon = await app.inject({ method: "GET", url: "/api/v1/catalog/courses" });
    expect(anon.statusCode).toBe(401);

    // admin 作为登录用户访问 learner API → 只得到 learner 只读结果（不含草稿标题）。
    const { courseId } = await createPublishedCourse();
    const adminCatalog = await admin.req("GET", `/api/v1/catalog/courses/${courseId}`, {});
    expect(adminCatalog.statusCode).toBe(200);
    const d = body(adminCatalog) as { releaseNumber: number; contentSource: string };
    expect(d.contentSource).toBe("published_release");

    // learner 不能访问 admin draft API。
    const draftAccess = await learner.req("GET", `/api/v1/admin/courses/${courseId}/draft`, {});
    expect(draftAccess.statusCode).toBe(403);
  });
});
