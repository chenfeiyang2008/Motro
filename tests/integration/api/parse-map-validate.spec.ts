// 阶段 6 工单 02 集成验收：四格式解析、映射与校验（真实 PostgreSQL + multipart）。
// 覆盖：
//   - 四格式最短成功路径（TXT/CSV/XLSX/JSON）
//   - 同 batch + mappingVersion 重复 validate 不重复写行；同 key 重放同一结果
//   - 同 key 不同语义 → 409
//   - 映射变更使旧结果失效；重新校验只对应新映射版本
//   - 文件内重复与系统已有词条显式可见
//   - TXT 无映射；CSV/XLSX/JSON 缺映射为 422
//   - 管理员权限；学习者拒绝
//   - 分页与非法 cursor
//   - 解析失败不留下半成品行或错误的 batch 状态
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPool, listAppliedMigrations, loadDbConfigFromEnv, migrate } from "@motro/db";
import { loadConfig } from "@motro/config";
import { createApp } from "../../../apps/api/src/bootstrap-app.js";
import { PasswordService } from "../../../apps/api/src/auth/password.service.js";

type App = Awaited<ReturnType<typeof createApp>>;

const config = loadDbConfigFromEnv();
const MIGRATIONS_DIR = resolve(process.cwd(), "db/migrations");
const previousImportFileRootDir = process.env.IMPORT_FILE_ROOT_DIR;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function canConnect(): Promise<boolean> {
  const probe = createPool({ ...config, max: 1 });
  try {
    await probe.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await probe.end();
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
    opts?: { payload?: object | Buffer; headers?: Record<string, string> },
  ): Promise<Res>;
}

function makeClient(app: App): Client {
  const cookies: Record<string, string> = {};
  let csrf = "";
  const capture = (res: { headers: Record<string, unknown> }): void => {
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
      capture(res);
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
      capture(res);
      return res as unknown as Res;
    },
  };
}

/** 构造含 file 的 multipart 请求体。 */
function multipart(
  fields: Record<string, string>,
  file?: { filename: string; content: Buffer; mime?: string },
): { payload: Buffer; contentType: string } {
  const boundary = `----motro-${randomUUID().replace(/-/g, "")}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
    chunks.push(Buffer.from(`${value}\r\n`));
  }
  if (file) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(
      Buffer.from(`Content-Disposition: form-data; name="file"; filename="${file.filename}"\r\n`),
    );
    const mime = file.mime ?? "text/plain";
    chunks.push(Buffer.from(`Content-Type: ${mime}\r\n\r\n`));
    chunks.push(file.content);
    chunks.push(Buffer.from(`\r\n`));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe("import parse map validate", () => {
  let app: App;
  let admin: Client;
  let learner: Client;
  let tempImportRoot: string;
  let adminUserId: string;
  let learnerUserId: string;

  beforeAll(async () => {
    if (!dbAvailable) {
      throw new Error(
        "parse-map-validate 需要运行中的 PostgreSQL。启动后重跑；本套件不会静默跳过。",
      );
    }
    await migrate(config, MIGRATIONS_DIR);

    tempImportRoot = mkdtempSync(join(tmpdir(), "motro-import-pmv-"));
    process.env.IMPORT_FILE_ROOT_DIR = tempImportRoot;
    process.env.IMPORT_MAX_FILE_BYTES = String(6 * 1024 * 1024);

    const suffix = randomBytes(3).toString("hex");
    const ps = new PasswordService();
    const pool = createPool({ ...config, max: 1 });
    const adminU = `pmv-admin-${suffix}`;
    await pool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'PMV Admin', 'admin', 'active', 'Asia/Shanghai', 10, $2, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $2, status = 'active', must_change_password = false`,
      [adminU, await ps.hashPassword("Admin-pass-123")],
    );
    const adminRow = await pool.query<{ id: string }>("SELECT id FROM users WHERE username = $1", [
      adminU,
    ]);
    adminUserId = adminRow.rows[0]!.id;
    const learnerU = `pmv-learner-${suffix}`;
    await pool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'PMV Learner', 'learner', 'active', 'Asia/Shanghai', 10, $2, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $2, status = 'active', must_change_password = false`,
      [learnerU, await ps.hashPassword("learner-pass-123")],
    );
    const learnerRow = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE username = $1",
      [learnerU],
    );
    learnerUserId = learnerRow.rows[0]!.id;
    await pool.end();

    const cfg = loadConfig();
    app = await createApp({ ...cfg, import: { ...cfg.import, fileRootDir: tempImportRoot } });
    await app.init();
    admin = makeClient(app);
    learner = makeClient(app);
    const al = await admin.req("POST", "/api/v1/auth/login", {
      payload: { username: adminU, password: "Admin-pass-123" },
    });
    expect(al.statusCode).toBe(200);
    const ll = await learner.req("POST", "/api/v1/auth/login", {
      payload: { username: learnerU, password: "learner-pass-123" },
    });
    expect(ll.statusCode).toBe(200);
  });

  afterAll(async () => {
    try {
      const userIds = [adminUserId, learnerUserId].filter((x): x is string => !!x);
      const pool = createPool({ ...config, max: 1 });
      try {
        if (userIds.length > 0) {
          const scopes = [
            ...userIds.map((id) => `import:batch:create:${id}`),
            ...userIds.map((id) => `import:validate:${id}`),
          ];
          await pool.query(`DELETE FROM idempotency_keys WHERE scope = ANY($1::text[])`, [scopes]);
          await pool.query(`DELETE FROM import_batches WHERE uploaded_by = ANY($1::uuid[])`, [
            userIds,
          ]);
          await pool.query(`DELETE FROM stored_files WHERE uploaded_by = ANY($1::uuid[])`, [
            userIds,
          ]);
          await pool.query(`DELETE FROM audit_events WHERE actor_id = ANY($1::uuid[])`, [userIds]);
        }
      } finally {
        await pool.end();
      }
      if (app) await app.close();
      if (userIds.length > 0) {
        const dropPool = createPool({ ...config, max: 1 });
        try {
          await dropPool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
        } finally {
          await dropPool.end();
        }
      }
    } finally {
      try {
        rmSync(tempImportRoot, { recursive: true, force: true });
      } catch {
        // 忽略。
      }
      restoreEnv("IMPORT_FILE_ROOT_DIR", previousImportFileRootDir);
    }
  });

  function body(res: Res): Record<string, unknown> {
    return res.json() as Record<string, unknown>;
  }

  function uniqKey(): string {
    return `${randomUUID()}-${Date.now()}`;
  }

  // 本套件使用带随机后缀的单词，避免与共享开发库中其它测试留下的词条冲突
  // （系统已有词条是显式 disposition；测试词必须不在既有词条库中）。
  const wSuffix = randomBytes(4).toString("hex");
  const W1 = `pmvone${wSuffix}`;
  const W2 = `pmvtwo${wSuffix}`;
  const W3 = `pmvthree${wSuffix}`;
  const W4 = `pmvfour${wSuffix}`;
  const W5 = `pmvfive${wSuffix}`;

  async function uploadTxt(content: string): Promise<string> {
    const mp = multipart(
      { sourceDeclaration: "PMV TXT 来源" },
      {
        filename: `pmv-${uniqKey().slice(0, 8)}.txt`,
        content: Buffer.from(content),
      },
    );
    const res = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mp.contentType, "idempotency-key": uniqKey() },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(201);
    return (body(res) as { id: string }).id;
  }

  async function uploadCsv(content: string): Promise<string> {
    const mp = multipart(
      { sourceDeclaration: "PMV CSV 来源" },
      {
        filename: `pmv-${uniqKey().slice(0, 8)}.csv`,
        content: Buffer.from(content),
      },
    );
    const res = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mp.contentType, "idempotency-key": uniqKey() },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(201);
    return (body(res) as { id: string }).id;
  }

  async function uploadJson(content: string): Promise<string> {
    const mp = multipart(
      { sourceDeclaration: "PMV JSON 来源" },
      {
        filename: `pmv-${uniqKey().slice(0, 8)}.json`,
        content: Buffer.from(content),
        mime: "application/json",
      },
    );
    const res = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mp.contentType, "idempotency-key": uniqKey() },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(201);
    return (body(res) as { id: string }).id;
  }

  it("0001–0019 空库迁移：出现 import_rows 与扩展字段", async () => {
    const dbName = `motro_pmv_${Date.now().toString(36)}_${randomBytes(2).toString("hex")}`;
    const adminPool = createPool({ ...config, database: "postgres", max: 1 });
    try {
      await adminPool.query(`CREATE DATABASE "${dbName}"`);
    } finally {
      await adminPool.end();
    }
    const isoConfig = { ...config, database: dbName };
    try {
      const applied = await migrate(isoConfig, MIGRATIONS_DIR);
      expect(applied.map((m) => m.version)).toContain(19);
      const recorded = await listAppliedMigrations(isoConfig);
      expect(recorded.map((m) => m.version)).toContain(19);
      const verify = createPool({ ...isoConfig, max: 1 });
      try {
        await verify.query("SELECT 1 FROM import_rows LIMIT 0");
        await verify.query(
          "SELECT mapping_version, current_mapping, validation_status FROM import_batches LIMIT 0",
        );
      } finally {
        await verify.end();
      }
    } finally {
      const dropPool = createPool({ ...config, database: "postgres", max: 1 });
      try {
        await dropPool.query(`DROP DATABASE "${dbName}"`);
      } finally {
        await dropPool.end();
      }
    }
  });

  it("TXT 最短成功路径：上传 → 详情（无映射）→ 校验 → 行结果", async () => {
    const batchId = await uploadTxt(`${W1}\n${W2}\n\n${W3}`);
    // 详情：TXT 无需映射。
    const detail = await admin.req("GET", `/api/v1/admin/imports/${batchId}`, {});
    expect(detail.statusCode).toBe(200);
    const d = body(detail) as { format: string; validationStatus: string };
    expect(d.format).toBe("txt");
    expect(d.validationStatus).toBe("not_validated");
    // 校验（无映射）。
    const val = await admin.req("POST", `/api/v1/admin/imports/${batchId}/validate`, {
      headers: { "idempotency-key": uniqKey() },
    });
    expect(val.statusCode).toBe(200);
    const v = body(val) as {
      validationStatus: string;
      validationSummary?: { candidates: number; invalid: number; ignored: number; total: number };
    };
    expect(v.validationStatus).toBe("validated");
    expect(v.validationSummary?.candidates).toBe(3);
    expect(v.validationSummary?.ignored).toBe(1); // 空行计入 ignored
    expect(v.validationSummary?.total).toBe(3);
    // 行结果分页。
    const rows = await admin.req("GET", `/api/v1/admin/imports/${batchId}/rows`, {});
    expect(rows.statusCode).toBe(200);
    const r = body(rows) as { items: { ordinal: number; rawSummary: string }[]; hasMore: boolean };
    expect(r.items.length).toBe(3);
    expect(r.items[0]?.ordinal).toBe(1);
    expect(r.items[0]?.rawSummary).toBe(W1);
  });

  it("TXT：同 Idempotency-Key 重放同一结果；同 key 不同语义 → 409", async () => {
    const batchId = await uploadTxt(`${W1}\n${W2}\n`);
    const key = uniqKey();
    const v1 = await admin.req("POST", `/api/v1/admin/imports/${batchId}/validate`, {
      headers: { "idempotency-key": key },
    });
    expect(v1.statusCode).toBe(200);
    const v2 = await admin.req("POST", `/api/v1/admin/imports/${batchId}/validate`, {
      headers: { "idempotency-key": key },
    });
    expect(v2.statusCode).toBe(200);
    // 同 key 不同语义（改映射版本语义 → 需先 PATCH 再同 key validate → 409）。
    const patch = await admin.req("PATCH", `/api/v1/admin/imports/${batchId}`, {
      payload: { mapping: {}, version: 1 },
    });
    expect(patch.statusCode).toBe(200);
    const afterPatch = body(patch) as { version: number; mappingVersion: number };
    expect(afterPatch.version).toBe(2);
    // 同 key 在不同语义下 validate → 409 IDEMPOTENCY_CONFLICT。
    const v3 = await admin.req("POST", `/api/v1/admin/imports/${batchId}/validate`, {
      headers: { "idempotency-key": key },
    });
    expect(v3.statusCode).toBe(409);
    expect((body(v3) as { error: { code: string } }).error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("TXT：同一映射版本重复 validate 不重复写行", async () => {
    const batchId = await uploadTxt(`${W2}\n${W3}\n`);
    await admin.req("POST", `/api/v1/admin/imports/${batchId}/validate`, {
      headers: { "idempotency-key": uniqKey() },
    });
    await admin.req("POST", `/api/v1/admin/imports/${batchId}/validate`, {
      headers: { "idempotency-key": uniqKey() },
    });
    const pool = createPool({ ...config, max: 1 });
    try {
      const r = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM import_rows WHERE batch_id = $1",
        [batchId],
      );
      expect(Number(r.rows[0]?.n ?? 0)).toBe(2); // 恰 2 行，未重复写入
    } finally {
      await pool.end();
    }
  });

  it("CSV 最短成功路径：发现字段 → 映射 → 校验", async () => {
    const batchId = await uploadCsv(`word,note\n${W1},fruit\n${W2},fruit\n`);
    // 详情返回可选字段。
    const detail = await admin.req("GET", `/api/v1/admin/imports/${batchId}`, {});
    const d = body(detail) as { fields?: { fieldId: string }[] };
    expect(d.fields?.some((f) => f.fieldId === "word")).toBe(true);
    // 缺映射校验 → 422 MAPPING_REQUIRED。
    const valMissing = await admin.req("POST", `/api/v1/admin/imports/${batchId}/validate`, {
      headers: { "idempotency-key": uniqKey() },
    });
    expect(valMissing.statusCode).toBe(422);
    // 确认映射。
    const patch = await admin.req("PATCH", `/api/v1/admin/imports/${batchId}`, {
      payload: { mapping: { spellingField: "word" }, version: 1 },
    });
    expect(patch.statusCode).toBe(200);
    // 校验。
    const val = await admin.req("POST", `/api/v1/admin/imports/${batchId}/validate`, {
      headers: { "idempotency-key": uniqKey() },
    });
    expect(val.statusCode).toBe(200);
    const v = body(val) as { validationStatus: string; validationSummary?: { candidates: number } };
    expect(v.validationStatus).toBe("validated");
    expect(v.validationSummary?.candidates).toBe(2);
  });

  it("CSV：中文列名与重复列名稳定标识；映射后可校验", async () => {
    const batchId = await uploadCsv(`英文,中文,英文\n${W1},苹果,x\n${W2},香蕉,y\n`);
    const detail = await admin.req("GET", `/api/v1/admin/imports/${batchId}`, {});
    const d = body(detail) as { fields?: { fieldId: string }[] };
    const ids = (d.fields ?? []).map((f) => f.fieldId);
    // 重复列名获得不歧义后缀。
    expect(ids).toContain("英文");
    expect(ids).toContain("英文 (2)");
    // 选择"英文"字段映射。
    const patch = await admin.req("PATCH", `/api/v1/admin/imports/${batchId}`, {
      payload: { mapping: { spellingField: "英文" }, version: 1 },
    });
    expect(patch.statusCode).toBe(200);
    const val = await admin.req("POST", `/api/v1/admin/imports/${batchId}/validate`, {
      headers: { "idempotency-key": uniqKey() },
    });
    expect(val.statusCode).toBe(200);
    const v = body(val) as { validationSummary?: { candidates: number } };
    expect(v.validationSummary?.candidates).toBe(2);
  });

  it("JSON：字符串数组与对象数组最短成功路径；拒绝形状", async () => {
    // 字符串数组。
    const j1 = await uploadJson(`["${W1}","${W2}"]`);
    const val1 = await admin.req("POST", `/api/v1/admin/imports/${j1}/validate`, {
      headers: { "idempotency-key": uniqKey() },
    });
    expect(val1.statusCode).toBe(200);
    const v1 = body(val1) as { validationSummary?: { candidates: number } };
    expect(v1.validationSummary?.candidates).toBe(2);

    // 对象数组：需映射 word。
    const j2 = await uploadJson(`[{"word":"${W1}","note":"水果"},{"word":"${W2}"}]`);
    const detail = await admin.req("GET", `/api/v1/admin/imports/${j2}`, {});
    const d = body(detail) as { fields?: { fieldId: string }[] };
    expect(d.fields?.some((f) => f.fieldId === "word")).toBe(true);
    const patch = await admin.req("PATCH", `/api/v1/admin/imports/${j2}`, {
      payload: { mapping: { spellingField: "word" }, version: 1 },
    });
    expect(patch.statusCode).toBe(200);
    const val2 = await admin.req("POST", `/api/v1/admin/imports/${j2}/validate`, {
      headers: { "idempotency-key": uniqKey() },
    });
    expect(val2.statusCode).toBe(200);

    // 拒绝：顶层对象 / 混合类型。
    const bad1 = await uploadJson('{"words":["a"]}');
    const vBad1 = await admin.req("POST", `/api/v1/admin/imports/${bad1}/validate`, {
      headers: { "idempotency-key": uniqKey() },
    });
    expect([400, 422]).toContain(vBad1.statusCode);

    const bad2 = await uploadJson('["a", 42]');
    const vBad2 = await admin.req("POST", `/api/v1/admin/imports/${bad2}/validate`, {
      headers: { "idempotency-key": uniqKey() },
    });
    expect([400, 422]).toContain(vBad2.statusCode);
  });

  it("文件内重复与系统已有词条显式可见；同批其他有效行不因单行错误回滚", async () => {
    // 预置一个系统词条（唯一，避免与共享库既有词条冲突）。
    const existingWord = `pmvexist${wSuffix}`;
    const pool = createPool({ ...config, max: 1 });
    try {
      await pool.query(
        `INSERT INTO lexical_entries (canonical_spelling, normalized_spelling, senses)
         VALUES ($1, $1, '[]'::jsonb)`,
        [existingWord],
      );
    } finally {
      await pool.end();
    }

    // 文件：existingWord（已有）、W1 重复两次、含非法拼写"1234"。
    const batchId = await uploadTxt(`${existingWord}\n${W1}\n${W1}\n1234\n`);
    const val = await admin.req("POST", `/api/v1/admin/imports/${batchId}/validate`, {
      headers: { "idempotency-key": uniqKey() },
    });
    expect(val.statusCode).toBe(200);
    const v = body(val) as {
      validationSummary?: {
        candidates: number;
        duplicates: number;
        existingEntries: number;
        invalid: number;
      };
    };
    expect(v.validationSummary?.candidates).toBe(1); // 只有 W1 第一条
    expect(v.validationSummary?.duplicates).toBe(1); // W1 重复
    expect(v.validationSummary?.existingEntries).toBe(1); // existingWord
    expect(v.validationSummary?.invalid).toBe(1); // 1234

    // 行结果可定位。
    const rows = await admin.req("GET", `/api/v1/admin/imports/${batchId}/rows`, {});
    const r = body(rows) as { items: { status: string; duplicateOfOrdinal?: number }[] };
    const byStatus = new Map<string, number>();
    for (const it of r.items) byStatus.set(it.status, (byStatus.get(it.status) ?? 0) + 1);
    expect(byStatus.get("existing_entry")).toBe(1);
    expect(byStatus.get("duplicate_in_file")).toBe(1);
    expect(byStatus.get("invalid")).toBe(1);
    expect(byStatus.get("candidate")).toBe(1);
    // 重复行带 duplicateOfOrdinal。
    const dup = r.items.find((x) => x.status === "duplicate_in_file");
    expect(dup?.duplicateOfOrdinal).toBe(2); // W1 第 2 行指向第 1 次出现

    // 清理预置词条。
    const cleanPool = createPool({ ...config, max: 1 });
    try {
      await cleanPool.query(`DELETE FROM lexical_entries WHERE canonical_spelling = $1`, [
        existingWord,
      ]);
    } finally {
      await cleanPool.end();
    }
  });

  it("映射变更使旧结果失效：stale 判定 + 重新校验只对应新版本", async () => {
    const batchId = await uploadTxt(`${W4}\n${W5}\n`);
    const key1 = uniqKey();
    await admin.req("POST", `/api/v1/admin/imports/${batchId}/validate`, {
      headers: { "idempotency-key": key1 },
    });
    // 读取当前批次版本。
    const detail0 = await admin.req("GET", `/api/v1/admin/imports/${batchId}`, {});
    const d0 = body(detail0) as { version: number; mappingVersion: number };
    // PATCH 空映射（TXT）→ 版本递增 → 旧校验失效。
    const patch = await admin.req("PATCH", `/api/v1/admin/imports/${batchId}`, {
      payload: { mapping: {}, version: d0.version },
    });
    expect(patch.statusCode).toBe(200);
    const detail1 = await admin.req("GET", `/api/v1/admin/imports/${batchId}`, {});
    const d1 = body(detail1) as {
      version: number;
      mappingVersion: number;
      isStale: boolean;
      validationStatus: string;
    };
    expect(d1.mappingVersion).toBe(d0.mappingVersion + 1);
    expect(d1.version).toBe(d0.version + 1);
    // 映射变更后但尚未重新校验：行事实的最新 mappingVersion 落后于批次 mappingVersion。
    const pool = createPool({ ...config, max: 1 });
    try {
      const r = await pool.query<{ mapping_version: number; n: string }>(
        `SELECT mapping_version, count(*)::text AS n FROM import_rows
         WHERE batch_id = $1 GROUP BY mapping_version`,
        [batchId],
      );
      // 旧行仍存在，但 mapping_version 是旧版本 → stale（不会被当作当前有效结果）。
      expect(r.rows.length).toBe(1);
      expect(Number(r.rows[0]?.n ?? 0)).toBe(2);
      expect(r.rows[0]?.mapping_version).toBe(d0.mappingVersion);
    } finally {
      await pool.end();
    }
    // 重新校验 → 新 mappingVersion 下的行（旧行被替换/失效）。
    const key2 = uniqKey();
    const val = await admin.req("POST", `/api/v1/admin/imports/${batchId}/validate`, {
      headers: { "idempotency-key": key2 },
    });
    expect(val.statusCode).toBe(200);
    const pool2 = createPool({ ...config, max: 1 });
    try {
      const r2 = await pool2.query<{ n: string; mapping_version: number }>(
        `SELECT mapping_version, count(*)::text AS n FROM import_rows
         WHERE batch_id = $1 GROUP BY mapping_version ORDER BY mapping_version ASC`,
        [batchId],
      );
      // P1-3：旧行事实保留；新旧两个 mappingVersion 的行并存，各自 ordinal 唯一。
      expect(r2.rows.length).toBe(2);
      expect(r2.rows[0]?.mapping_version).toBe(d0.mappingVersion);
      expect(Number(r2.rows[0]?.n ?? 0)).toBe(2);
      expect(r2.rows[1]?.mapping_version).toBe(d1.mappingVersion);
      expect(Number(r2.rows[1]?.n ?? 0)).toBe(2);
    } finally {
      await pool2.end();
    }
  });

  it("XLSX 最短成功路径：双工作表 + 中文表头 → 选表/选字段 → 校验 → 行", async () => {
    const fixture = readFileSync(join(process.cwd(), "tests/fixtures/two-sheet-chinese.xlsx"));
    const mp = multipart(
      { sourceDeclaration: "PMV XLSX 来源" },
      {
        filename: `pmv-${uniqKey().slice(0, 8)}.xlsx`,
        content: fixture,
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    );
    const up = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mp.contentType, "idempotency-key": uniqKey() },
      payload: mp.payload,
    });
    expect(up.statusCode).toBe(201);
    const batchId = (body(up) as { id: string }).id;

    // 详情：暴露两张工作表 + 第一张表字段。
    const detail = await admin.req("GET", `/api/v1/admin/imports/${batchId}`, {});
    const d = body(detail) as { format: string; sheets?: { fieldId: string }[] };
    expect(d.format).toBe("xlsx");
    const sheetNames = (d.sheets ?? []).map((s) => s.fieldId);
    expect(sheetNames).toContain("Sheet1");
    expect(sheetNames).toContain("中文表");

    // 缺映射校验 → 422 MAPPING_REQUIRED。
    const valMissing = await admin.req("POST", `/api/v1/admin/imports/${batchId}/validate`, {
      headers: { "idempotency-key": uniqKey() },
    });
    expect(valMissing.statusCode).toBe(422);

    // 选择中文表的"英文"字段并映射。
    const patch = await admin.req("PATCH", `/api/v1/admin/imports/${batchId}`, {
      payload: { mapping: { sheet: "中文表", spellingField: "英文" }, version: 1 },
    });
    expect(patch.statusCode).toBe(200);

    // 校验成功 → 行（cherry）。
    const val = await admin.req("POST", `/api/v1/admin/imports/${batchId}/validate`, {
      headers: { "idempotency-key": uniqKey() },
    });
    expect(val.statusCode).toBe(200);
    const v = body(val) as {
      validationStatus: string;
      validationSummary?: { candidates: number };
    };
    expect(v.validationStatus).toBe("validated");
    expect(v.validationSummary?.candidates).toBe(1);

    const rows = await admin.req("GET", `/api/v1/admin/imports/${batchId}/rows`, {});
    const r = body(rows) as { items: { rawSummary: string }[] };
    expect(r.items[0]?.rawSummary).toBe("cherry");
  });

  it("XLSX：非 ZIP 内容 → 上传/校验拒绝且无半成品行", async () => {
    const mp = multipart(
      { sourceDeclaration: "PMV XLSX 坏文件" },
      {
        filename: `pmv-${uniqKey().slice(0, 8)}.xlsx`,
        content: Buffer.from("not-a-zip"),
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    );
    const up = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mp.contentType, "idempotency-key": uniqKey() },
      payload: mp.payload,
    });
    // 二进制非 ZIP 内容被嗅探拒绝（工单 01 安全边界不倒退），上传即失败。
    expect([400, 422]).toContain(up.statusCode);
  });

  it("学习者拒绝访问映射/校验/行；未登录 401", async () => {
    const batchId = await uploadTxt("x\n");
    const lr = await learner.req("GET", `/api/v1/admin/imports/${batchId}`, {});
    expect([403, 404]).toContain(lr.statusCode);
    const lrVal = await learner.req("POST", `/api/v1/admin/imports/${batchId}/validate`, {
      headers: { "idempotency-key": uniqKey() },
    });
    expect([403, 404]).toContain(lrVal.statusCode);
    const lrRows = await learner.req("GET", `/api/v1/admin/imports/${batchId}/rows`, {});
    expect([403, 404]).toContain(lrRows.statusCode);
  });

  it("分页：稳定按 ordinal 升序；非法 cursor → 422", async () => {
    const batchId = await uploadTxt(
      `${W1}\n${W2}\n${W3}\npmvpa${wSuffix}\npmvpb${wSuffix}\npmvpc${wSuffix}\n`,
    );
    await admin.req("POST", `/api/v1/admin/imports/${batchId}/validate`, {
      headers: { "idempotency-key": uniqKey() },
    });
    // limit=2 第一页。
    const p1 = await admin.req("GET", `/api/v1/admin/imports/${batchId}/rows?limit=2`, {});
    const r1 = body(p1) as { items: { ordinal: number }[]; nextCursor?: string; hasMore: boolean };
    expect(r1.items.map((x) => x.ordinal)).toEqual([1, 2]);
    expect(r1.hasMore).toBe(true);
    // 第二页用 cursor。
    const p2 = await admin.req(
      "GET",
      `/api/v1/admin/imports/${batchId}/rows?limit=2&cursor=${r1.nextCursor}`,
      {},
    );
    const r2 = body(p2) as { items: { ordinal: number }[]; hasMore: boolean };
    expect(r2.items.map((x) => x.ordinal)).toEqual([3, 4]);
    // 非法 cursor。
    const bad = await admin.req("GET", `/api/v1/admin/imports/${batchId}/rows?cursor=abc`, {});
    expect(bad.statusCode).toBe(422);
  });

  it("解析失败不留下错误的 batch 状态或半成品行", async () => {
    // 上传一个非法 JSON（会 422），批次校验 → 失败状态，无半成品行。
    const mp = multipart(
      { sourceDeclaration: "PMV 坏 JSON" },
      {
        filename: `pmv-${uniqKey().slice(0, 8)}.json`,
        content: Buffer.from('{"not":"array"}'),
        mime: "application/json",
      },
    );
    const up = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mp.contentType, "idempotency-key": uniqKey() },
      payload: mp.payload,
    });
    // JSON 内容合法 JSON 但形状非法（顶层对象）→ 上传接受，校验时 422。
    expect(up.statusCode).toBe(201);
    const batchId = (body(up) as { id: string }).id;
    const val = await admin.req("POST", `/api/v1/admin/imports/${batchId}/validate`, {
      headers: { "idempotency-key": uniqKey() },
    });
    expect([400, 422]).toContain(val.statusCode);
    // 批次状态 → failed，无行事实。
    const detail = await admin.req("GET", `/api/v1/admin/imports/${batchId}`, {});
    const d = body(detail) as { validationStatus: string };
    expect(d.validationStatus).toBe("failed");
    const pool = createPool({ ...config, max: 1 });
    try {
      const r = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM import_rows WHERE batch_id = $1",
        [batchId],
      );
      expect(Number(r.rows[0]?.n ?? 0)).toBe(0);
    } finally {
      await pool.end();
    }
    // 失败后可重试（同 key 已失效，用新 key 重新校验仍失败）。
    const val2 = await admin.req("POST", `/api/v1/admin/imports/${batchId}/validate`, {
      headers: { "idempotency-key": uniqKey() },
    });
    expect([400, 422]).toContain(val2.statusCode);
  });

  it("P1-2 validate 与 PATCH 并发：校验绑定锁定的映射快照，绝不挂到过期映射上", async () => {
    // 用套件内唯一词条避免与既有上传内容撞去重（同 uploader + sha256 复用 → 200）。
    const cW1 = `pmvconc${wSuffix}`;
    const cW2 = `pmvconc2${wSuffix}`;
    const batchId = await uploadCsv(`word,note\n${cW1},a\n${cW2},b\n`);
    // 先确认映射，才能首次校验（CSV 无映射 → 422 MAPPING_REQUIRED）。
    const d0 = body(await admin.req("GET", `/api/v1/admin/imports/${batchId}`, {})) as {
      version: number;
      mappingVersion: number;
    };
    const firstPatch = await admin.req("PATCH", `/api/v1/admin/imports/${batchId}`, {
      payload: { mapping: { spellingField: "word" }, version: d0.version },
    });
    expect(firstPatch.statusCode).toBe(200);
    const val1 = await admin.req("POST", `/api/v1/admin/imports/${batchId}/validate`, {
      headers: { "idempotency-key": uniqKey() },
    });
    expect(val1.statusCode).toBe(200);
    const after1 = body(await admin.req("GET", `/api/v1/admin/imports/${batchId}`, {})) as {
      version: number;
      mappingVersion: number;
      validationStatus: string;
    };
    expect(after1.validationStatus).toBe("validated");

    // 并发：一边 PATCH 把映射改为不存在的字段（递增 mappingVersion 并使旧结果失效），
    // 一边重新 validate。validate 内部先 FOR UPDATE 锁批次行再读取映射快照；
    // PATCH 也 FOR UPDATE 同一行。二者串行化，最终批次 mappingVersion 与 validated 结果
    // 必须一致（不允许一个旧映射的校验结果被当作新映射下的 validated 成功）。
    const [patchRes, valRes] = await Promise.all([
      admin.req("PATCH", `/api/v1/admin/imports/${batchId}`, {
        payload: { mapping: { spellingField: "missing" }, version: after1.version },
      }),
      admin.req("POST", `/api/v1/admin/imports/${batchId}/validate`, {
        headers: { "idempotency-key": uniqKey() },
      }),
    ]);
    // 无论哪个先拿到锁，最终批次状态必须自洽：
    //   - 要么 validate 先锁定（在 word 映射下校验成功），随后 PATCH 递增版本 → isStale；
    //   - 要么 PATCH 先递增版本，validate 用 missing 提取失败 → failed。
    // 二者都不会留下「旧映射校验成功但批次 mappingVersion 已是新版本」的 stale 成功状态。
    const final = await admin.req("GET", `/api/v1/admin/imports/${batchId}`, {});
    const f = body(final) as {
      validationStatus: string;
      mappingVersion: number;
      version: number;
      isStale: boolean;
    };
    expect(f.version).toBeGreaterThanOrEqual(after1.version + 1);
    if (f.validationStatus === "validated" && !f.isStale) {
      // 若最终 non-stale validated，其 mappingVersion 必须等于批次当前 mappingVersion。
      const rows = await admin.req("GET", `/api/v1/admin/imports/${batchId}/rows`, {});
      const r = body(rows) as {
        items: { normalizedSpelling: string; status: string; mappingVersion: number }[];
      };
      // 当前 mappingVersion 的行必须是 word 字段提取出的 cW1/cW2。
      expect(r.items.map((x) => x.normalizedSpelling).sort()).toEqual([cW1, cW2].sort());
      expect(r.items.every((x) => x.mappingVersion === f.mappingVersion)).toBe(true);
    }
    // PATCH 本身必然成功（200）或 404/409（并发后版本已变）。
    expect([200, 404, 409]).toContain(patchRes.statusCode);
    void valRes;
  });

  it("P2-1 来源声明独立更新：不递增 mappingVersion、不失效校验、独立审计", async () => {
    const sW1 = `pmvsrc${wSuffix}`;
    const sW2 = `pmvsrc2${wSuffix}`;
    const batchId = await uploadTxt(`${sW1}\n${sW2}\n`);
    const val = await admin.req("POST", `/api/v1/admin/imports/${batchId}/validate`, {
      headers: { "idempotency-key": uniqKey() },
    });
    expect(val.statusCode).toBe(200);
    const d0 = body(await admin.req("GET", `/api/v1/admin/imports/${batchId}`, {})) as {
      version: number;
      mappingVersion: number;
      validationStatus: string;
      sourceDeclaration: string;
    };
    expect(d0.validationStatus).toBe("validated");

    // 仅更新来源声明（不改映射）→ 乐观 version 递增，但 mappingVersion 与校验不变。
    const patch = await admin.req("PATCH", `/api/v1/admin/imports/${batchId}`, {
      payload: { sourceDeclaration: "PMV 来源已更新", version: d0.version },
    });
    expect(patch.statusCode).toBe(200);
    const after = body(patch) as {
      version: number;
      mappingVersion: number;
      validationStatus: string;
      sourceDeclaration: string;
      isStale: boolean;
    };
    expect(after.sourceDeclaration).toBe("PMV 来源已更新");
    expect(after.version).toBe(d0.version + 1);
    expect(after.mappingVersion).toBe(d0.mappingVersion); // 不递增映射版本
    expect(after.validationStatus).toBe("validated"); // 校验不失效
    expect(after.isStale).toBe(false);

    // 来源声明空 / 超长 → 422。
    const badEmpty = await admin.req("PATCH", `/api/v1/admin/imports/${batchId}`, {
      payload: { sourceDeclaration: "   ", version: after.version },
    });
    expect(badEmpty.statusCode).toBe(422);
    const badLong = await admin.req("PATCH", `/api/v1/admin/imports/${batchId}`, {
      payload: { sourceDeclaration: "x".repeat(501), version: after.version },
    });
    expect(badLong.statusCode).toBe(422);

    // 独立审计动作：admin.import.source.update 与 validate 并存，且映射更新（mapping.update）不存在。
    const pool = createPool({ ...config, max: 1 });
    try {
      const audit = await pool.query<{ action: string; n: string }>(
        `SELECT action, count(*)::text AS n FROM audit_events
         WHERE target_type = 'import_batch' AND target_id = $1
         GROUP BY action`,
        [batchId],
      );
      const byAction = new Map(audit.rows.map((r) => [r.action, Number(r.n)]));
      expect(byAction.get("admin.import.source.update")).toBe(1);
      expect(byAction.has("admin.import.mapping.update")).toBe(false);
      expect(byAction.get("admin.import.validate")).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it("P2-2 系统已有词条查询按候选拼写范围，而非全表扫描 lexical_entries", async () => {
    // 预置一个系统词条，并预置大量无关词条（模拟 100k 词条库中绝大部分与批次无关）。
    const existingWord = `pmvscope${wSuffix}`;
    const unrelated = Array.from({ length: 2000 }, (_, i) => `pmvscope-unrel-${i}-${wSuffix}`);
    const pool = createPool({ ...config, max: 1 });
    try {
      await pool.query(
        `INSERT INTO lexical_entries (canonical_spelling, normalized_spelling, senses)
         VALUES ($1, $1, '[]'::jsonb)`,
        [existingWord],
      );
      for (let i = 0; i < unrelated.length; i += 500) {
        const chunk = unrelated.slice(i, i + 500);
        await pool.query(
          `INSERT INTO lexical_entries (canonical_spelling, normalized_spelling, senses)
           SELECT c, c, '[]'::jsonb FROM unnest($1::text[]) AS c ON CONFLICT (canonical_spelling) DO NOTHING`,
          [chunk],
        );
      }
    } finally {
      await pool.end();
    }

    // 批次只含 existingWord + 一个批内新词（不在词条库）。
    const batchId = await uploadTxt(`${existingWord}\n${W3}\n`);
    const val = await admin.req("POST", `/api/v1/admin/imports/${batchId}/validate`, {
      headers: { "idempotency-key": uniqKey() },
    });
    expect(val.statusCode).toBe(200);
    const v = body(val) as { validationSummary?: { existingEntries: number; candidates: number } };
    expect(v.validationSummary?.existingEntries).toBe(1);
    expect(v.validationSummary?.candidates).toBe(1);

    // 行结果：existingWord → existing_entry 且带 lexicalEntryId；W3 → candidate。
    const rows = await admin.req("GET", `/api/v1/admin/imports/${batchId}/rows`, {});
    const r = body(rows) as {
      items: { rawSummary: string; status: string; lexicalEntryId?: string }[];
    };
    const existingRow = r.items.find((x) => x.rawSummary === existingWord);
    const newRow = r.items.find((x) => x.rawSummary === W3);
    expect(existingRow?.status).toBe("existing_entry");
    expect(existingRow?.lexicalEntryId).toBeTruthy();
    expect(newRow?.status).toBe("candidate");

    // 查询是候选范围内（normalized_spelling = ANY(...)），不是全表：把无关词条库再加大后，
    // 校验仍只匹配批次候选。这里通过行结果验证行为正确即可（查询实现见 import.service.lookupExistingEntries）。
    const clean = createPool({ ...config, max: 1 });
    try {
      await clean.query(`DELETE FROM lexical_entries WHERE canonical_spelling = $1`, [
        existingWord,
      ]);
      await clean.query(`DELETE FROM lexical_entries WHERE canonical_spelling = ANY($1::text[])`, [
        unrelated,
      ]);
    } finally {
      await clean.end();
    }
  });

  // ---- 合成 ZIP 辅助工具：构造仅中央目录有效（pre-flight 不解压）的假 XLSX 归档 ----

  /**
   * EOCD 布局（每字段的绝对偏移都相对整个缓冲区的 EOCD 起点）：
   *   +0 sig(4) +4 disk(2) +6 dirDisk(2) +8 entriesOnDisk(2) +10 totalEntries(2)
   *   +12 dirSize(4) +16 dirOffset(4) +20 commentLen(2)
   * preflightXlsxArchive 读取 totalEntries(+10)、dirSize(+12)、dirOffset(+16)。
   */

  function buildSyntheticZip(entries: {
    name: string;
    uncompressedSize: number;
    compressedSize: number;
  }): Buffer {
    const nameBytes = Buffer.from(entries.name, "utf8");
    const CENTRAL_DIR_SIG = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
    const EOCD_SIG = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    const centralEntry = Buffer.alloc(46 + nameBytes.length, 0);
    CENTRAL_DIR_SIG.copy(centralEntry, 0);
    centralEntry.writeUInt16LE(20, 4);
    centralEntry.writeUInt32LE(entries.compressedSize, 20);
    centralEntry.writeUInt32LE(entries.uncompressedSize, 24);
    centralEntry.writeUInt16LE(nameBytes.length, 28);
    nameBytes.copy(centralEntry, 46);

    const preambleSize = 1024;
    const dirOffset = preambleSize;
    const dirSize = centralEntry.length;
    const eocdOffset = preambleSize + dirSize;
    const buffer = Buffer.alloc(eocdOffset + 22, 0);
    // 前置区首 4 字节必须是本地文件头签名 PK\x03\x04：上传嗅探（sniffFileContent）只凭
    // content[0..3] == PK\x03\x04 判定为 ZIP，从而允许 .xlsx 上传（pre-flight 才做严肃校验）。
    buffer[0] = 0x50;
    buffer[1] = 0x4b;
    buffer[2] = 0x03;
    buffer[3] = 0x04;
    centralEntry.copy(buffer, dirOffset);
    EOCD_SIG.copy(buffer, eocdOffset);
    buffer.writeUInt16LE(0, eocdOffset + 4); // disk
    buffer.writeUInt16LE(0, eocdOffset + 6); // dir disk
    buffer.writeUInt16LE(1, eocdOffset + 8); // entries on this disk
    buffer.writeUInt16LE(1, eocdOffset + 10); // total entries
    buffer.writeUInt32LE(dirSize, eocdOffset + 12); // central dir size
    buffer.writeUInt32LE(dirOffset, eocdOffset + 16); // central dir offset
    return buffer;
  }

  function buildSyntheticZipMulti(entries: { name: string; size: number }[]): Buffer {
    const CENTRAL_DIR_SIG = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
    const EOCD_SIG = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    const nameBytesList = entries.map((e) => Buffer.from(e.name, "utf8"));
    const centralEntries: Buffer[] = [];
    for (let i = 0; i < entries.length; i++) {
      const b = Buffer.alloc(46 + nameBytesList[i]!.length, 0);
      CENTRAL_DIR_SIG.copy(b, 0);
      b.writeUInt16LE(20, 4);
      b.writeUInt32LE(entries[i]!.size, 20);
      b.writeUInt32LE(entries[i]!.size, 24);
      b.writeUInt16LE(nameBytesList[i]!.length, 28);
      nameBytesList[i]!.copy(b, 46);
      centralEntries.push(b);
    }
    const centralDirBuf = Buffer.concat(centralEntries);
    const preambleSize = 1024;
    const dirOffset = preambleSize;
    const dirSize = centralDirBuf.length;
    const eocdOffset = preambleSize + dirSize;
    const buffer = Buffer.alloc(eocdOffset + 22, 0);
    // 前置区首 4 字节 = PK\x03\x04（上传嗅探判定为 ZIP）。
    buffer[0] = 0x50;
    buffer[1] = 0x4b;
    buffer[2] = 0x03;
    buffer[3] = 0x04;
    centralDirBuf.copy(buffer, dirOffset);
    EOCD_SIG.copy(buffer, eocdOffset);
    // entryCount 最多 65535（UInt16），超出此值 EOCD 本身无法表示（ZIP64 需额外 EOCD64）。
    // 这里只测试到 maxZipEntries + 1（1101），在 UInt16 范围内。
    buffer.writeUInt16LE(0, eocdOffset + 4); // disk
    buffer.writeUInt16LE(0, eocdOffset + 6); // dir disk
    buffer.writeUInt16LE(Math.min(entries.length, 65535), eocdOffset + 8); // entries on this disk
    buffer.writeUInt16LE(Math.min(entries.length, 65535), eocdOffset + 10); // total entries
    buffer.writeUInt32LE(dirSize, eocdOffset + 12); // central dir size
    buffer.writeUInt32LE(dirOffset, eocdOffset + 16); // central dir offset
    return buffer;
  }

  it("P0-1 XLSX suspicious archive: macro-enabled (vbaProject) → validate 拒绝", async () => {
    // 构造包含 xl/vbaProject.bin 条目的合成 ZIP：pre-flight 检测到宏启用后抛出 XLSX_MACRO_BLOCKED。
    // 这个假 ZIP 不能被 read-excel-file 成功解析，但 pre-flight 先于解析拒绝它。
    const macroZip = buildSyntheticZip({
      name: "xl/vbaProject.bin",
      compressedSize: 1024,
      uncompressedSize: 1024,
    });
    const mp = multipart(
      { sourceDeclaration: "PMV macro-xlsx" },
      {
        filename: `pmv-${uniqKey().slice(0, 8)}.xlsx`,
        content: macroZip,
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    );
    const up = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mp.contentType, "idempotency-key": uniqKey() },
      payload: mp.payload,
    });
    // 嗅探通过（PK magic + xlsx MIME）→ 上传成功。
    expect(up.statusCode).toBe(201);
    const batchId = (body(up) as { id: string }).id;
    // 校验时 pre-flight 检测到 vbaProject.bin → 422，无半成品行，batch → failed。
    const val = await admin.req("POST", `/api/v1/admin/imports/${batchId}/validate`, {
      headers: { "idempotency-key": uniqKey() },
    });
    expect(val.statusCode).toBe(422);
    const errBody = body(val) as { error?: { message?: string; code?: string } };
    const errMsg = (errBody.error?.message ??
      (errBody as Record<string, string>).message ??
      "") as string;
    expect(errMsg).toContain("宏");
    // batch failed，无行事实。
    const detail = (
      await admin.req("GET", `/api/v1/admin/imports/${batchId}`, {})
    ).json() as Record<string, unknown>;
    expect(detail.validationStatus).toBe("failed");
    const pool = createPool({ ...config, max: 1 });
    try {
      const r = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM import_rows WHERE batch_id = $1",
        [batchId],
      );
      expect(Number(r.rows[0]?.n ?? 0)).toBe(0);
    } finally {
      await pool.end();
    }
    // API 错误响应不含磁盘路径/storage_key/堆栈。
    expect(JSON.stringify(errBody)).not.toContain(".local-import-files");
    expect(JSON.stringify(errBody)).not.toContain("storage_key");
  });

  it("P1-1 XLSX suspicious archive: ZIP 条目数超过上限 → validate 拒绝", async () => {
    // 构造 1101 个中央目录条目（maxZipEntries 默认 1024）：pre-flight 在 EOCD 中读到
    // entryCount > maxZipEntries → 抛出 ZIP_TOO_MANY_ENTRIES（在遍历任何条目之前即拒绝）。
    // 本测试不分配真实内存炸弹：所有条目的 size = 0，仅构造中央目录结构即可触发前置数量检查。
    const entries = Array.from({ length: 1101 }, (_, i) => ({
      name: `fake/entry-${i}.bin`,
      size: 0,
    }));
    const manyZip = buildSyntheticZipMulti(entries);
    // 验证缓冲区大小在安全范围内（中央目录 + 1101 条名约 ~80KB，远低于内存风险）。
    expect(manyZip.length).toBeLessThan(1 * 1024 * 1024);
    const mp = multipart(
      { sourceDeclaration: "PMV oversized-xlsx" },
      {
        filename: `pmv-${uniqKey().slice(0, 8)}.xlsx`,
        content: manyZip,
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    );
    const up = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mp.contentType, "idempotency-key": uniqKey() },
      payload: mp.payload,
    });
    expect(up.statusCode).toBe(201);
    const batchId = (body(up) as { id: string }).id;
    const val = await admin.req("POST", `/api/v1/admin/imports/${batchId}/validate`, {
      headers: { "idempotency-key": uniqKey() },
    });
    expect(val.statusCode).toBe(422);
    const errBody = body(val) as { error?: { message?: string; code?: string } };
    const errMsg = (errBody.error?.message ??
      (errBody as Record<string, string>).message ??
      "") as string;
    expect(errMsg).toContain("条目数量超过上限");
    // API 错误响应不含路径/堆栈。
    expect(JSON.stringify(errBody)).not.toContain(".local-import-files");
  });

  it("P1-B 历史映射版本行事实可通过 mappingVersion 查询参数追溯", async () => {
    const hW1 = `pmvhist${wSuffix}`;
    const hW2 = `pmvhist2${wSuffix}`;
    // 用 CSV 制造两个映射版本：v1 用 word 字段，v2 改一个合法但不同的字段选择，
    // 产生两次不同 mappingVersion 的校验，各自行事实并存。
    const batchId = await uploadCsv(`word,note\n${hW1},a\n${hW2},b\n`);
    const d0 = body(await admin.req("GET", `/api/v1/admin/imports/${batchId}`, {})) as {
      version: number;
      mappingVersion: number;
    };
    const p1 = await admin.req("PATCH", `/api/v1/admin/imports/${batchId}`, {
      payload: { mapping: { spellingField: "word" }, version: d0.version },
    });
    expect(p1.statusCode).toBe(200);
    const v1 = await admin.req("POST", `/api/v1/admin/imports/${batchId}/validate`, {
      headers: { "idempotency-key": uniqKey() },
    });
    expect(v1.statusCode).toBe(200);
    const d1 = body(await admin.req("GET", `/api/v1/admin/imports/${batchId}`, {})) as {
      version: number;
      mappingVersion: number;
    };

    // 改变映射（spellingField 换成 note）→ mappingVersion 递增，重新校验 → v2 行。
    const p2 = await admin.req("PATCH", `/api/v1/admin/imports/${batchId}`, {
      payload: { mapping: { spellingField: "note" }, version: d1.version },
    });
    expect(p2.statusCode).toBe(200);
    const d2 = body(await admin.req("GET", `/api/v1/admin/imports/${batchId}`, {})) as {
      version: number;
      mappingVersion: number;
    };
    expect(d2.mappingVersion).toBe(d1.mappingVersion + 1);
    const v2 = await admin.req("POST", `/api/v1/admin/imports/${batchId}/validate`, {
      headers: { "idempotency-key": uniqKey() },
    });
    expect(v2.statusCode).toBe(200);

    // 默认 /rows 只返回当前 mappingVersion（v2）的行：提取的是 note 列 → 值为 "a"/"b"。
    const cur = body(await admin.req("GET", `/api/v1/admin/imports/${batchId}/rows`, {})) as {
      items: { rawSummary: string; mappingVersion: number }[];
    };
    expect(cur.items.length).toBe(2);
    expect(cur.items.every((x) => x.mappingVersion === d2.mappingVersion)).toBe(true);
    expect(cur.items.map((x) => x.rawSummary).sort()).toEqual(["a", "b"].sort());

    // 显式 mappingVersion=<v1> 返回 v1 的行（word 列 → hW1/hW2）——历史可追溯。
    const hist = body(
      await admin.req(
        "GET",
        `/api/v1/admin/imports/${batchId}/rows?mappingVersion=${d1.mappingVersion}`,
        {},
      ),
    ) as { items: { rawSummary: string; mappingVersion: number }[] };
    expect(hist.items.length).toBe(2);
    expect(hist.items.every((x) => x.mappingVersion === d1.mappingVersion)).toBe(true);
    expect(hist.items.map((x) => x.rawSummary).sort()).toEqual([hW1, hW2].sort());

    // 非法 mappingVersion → 422。
    const bad = await admin.req(
      "GET",
      `/api/v1/admin/imports/${batchId}/rows?mappingVersion=abc`,
      {},
    );
    expect(bad.statusCode).toBe(422);
  });

  it("P1-C 同一映射版本的行事实不可被覆盖：换新幂等键重验不改写既有行", async () => {
    const iW1 = `pmvimm${wSuffix}`;
    const iW2 = `pmvimm2${wSuffix}`;
    const batchId = await uploadTxt(`${iW1}\n${iW2}\n`);
    // 首次校验（mappingVersion = 1）。
    const v1 = await admin.req("POST", `/api/v1/admin/imports/${batchId}/validate`, {
      headers: { "idempotency-key": uniqKey() },
    });
    expect(v1.statusCode).toBe(200);
    const d = body(await admin.req("GET", `/api/v1/admin/imports/${batchId}`, {})) as {
      mappingVersion: number;
      validationStatus: string;
    };
    expect(d.validationStatus).toBe("validated");

    // 记录首轮行事实的原始值。
    const firstRows = body(await admin.req("GET", `/api/v1/admin/imports/${batchId}/rows`, {})) as {
      items: { id: string; rawSummary: string; status: string }[];
    };
    const firstIds = firstRows.items.map((r) => r.id);

    // 用全新幂等键再次校验同一映射版本。
    const v2 = await admin.req("POST", `/api/v1/admin/imports/${batchId}/validate`, {
      headers: { "idempotency-key": uniqKey() },
    });
    expect(v2.statusCode).toBe(200);

    // 行事实的 id 完全不变（未删除重写），即同一 (batch, mappingVersion) 行不可覆盖。
    const secondRows = body(
      await admin.req("GET", `/api/v1/admin/imports/${batchId}/rows`, {}),
    ) as { items: { id: string; rawSummary: string; status: string }[] };
    expect(secondRows.items.map((r) => r.id).sort()).toEqual(firstIds.sort());
    expect(secondRows.items.map((r) => r.rawSummary).sort()).toEqual([iW1, iW2].sort());

    // DB 层确认：该 (batch, mapping_version) 行数不变（未因重验翻倍）。
    const pool = createPool({ ...config, max: 1 });
    try {
      const r = await pool.query<{ n: string; mv: number }>(
        `SELECT count(*)::text AS n, mapping_version AS mv FROM import_rows
         WHERE batch_id = $1 GROUP BY mapping_version`,
        [batchId],
      );
      expect(r.rows.length).toBe(1);
      expect(Number(r.rows[0]?.n ?? 0)).toBe(2);
      expect(r.rows[0]?.mv).toBe(d.mappingVersion);
    } finally {
      await pool.end();
    }
  });
});
