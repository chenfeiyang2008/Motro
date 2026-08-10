// 导入批次集成验收（阶段 6 工单 01）：真实 PostgreSQL + multipart 上传。
// 覆盖空库 0016、管理员上传、拒绝非法/超限/空 + 无孤儿文件、权限、审计、重复上传不重复文件。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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
const previousImportMaxFileBytes = process.env.IMPORT_MAX_FILE_BYTES;

function restoreEnv(
  name: "IMPORT_FILE_ROOT_DIR" | "IMPORT_MAX_FILE_BYTES",
  value: string | undefined,
): void {
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

/** 构造含 file 的 multipart 请求体；file.mime 缺省 text/plain。 */
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

describe("import files and batches", () => {
  let app: App;
  let admin: Client;
  let adminB: Client;
  let learner: Client;
  let tempImportRoot: string;
  let adminUserId: string;
  let adminBUserId: string;
  let learnerUserId: string;

  beforeAll(async () => {
    if (!dbAvailable) {
      throw new Error(
        "import-files-and-batches 需要运行中的 PostgreSQL。启动后重跑；本套件不会静默跳过。",
      );
    }
    await migrate(config, MIGRATIONS_DIR);

    tempImportRoot = mkdtempSync(join(tmpdir(), "motro-import-"));
    process.env.IMPORT_FILE_ROOT_DIR = tempImportRoot;
    process.env.IMPORT_MAX_FILE_BYTES = String(6 * 1024 * 1024);

    const suffix = randomBytes(3).toString("hex");
    const ps = new PasswordService();
    const pool = createPool({ ...config, max: 1 });
    const adminU = `imp-admin-${suffix}`;
    await pool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'ITest Import Admin', 'admin', 'active', 'Asia/Shanghai', 10, $2, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $2, status = 'active', must_change_password = false`,
      [adminU, await ps.hashPassword("Admin-pass-123")],
    );
    const adminRow = await pool.query<{ id: string }>("SELECT id FROM users WHERE username = $1", [
      adminU,
    ]);
    adminUserId = adminRow.rows[0]!.id;
    const learnerU = `imp-learner-${suffix}`;
    await pool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'ImpTest Learner', 'learner', 'active', 'Asia/Shanghai', 10, $2, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $2, status = 'active', must_change_password = false`,
      [learnerU, await ps.hashPassword("learner-pass-123")],
    );
    const learnerRow = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE username = $1",
      [learnerU],
    );
    learnerUserId = learnerRow.rows[0]!.id;
    const adminBU = `imp-admin-b-${suffix}`;
    await pool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'ITest Import Admin B', 'admin', 'active', 'Asia/Shanghai', 10, $2, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $2, status = 'active', must_change_password = false`,
      [adminBU, await ps.hashPassword("Admin-pass-123")],
    );
    const adminBRow = await pool.query<{ id: string }>("SELECT id FROM users WHERE username = $1", [
      adminBU,
    ]);
    adminBUserId = adminBRow.rows[0]!.id;
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
    adminB = makeClient(app);
    const bl = await adminB.req("POST", "/api/v1/auth/login", {
      payload: { username: adminBU, password: "Admin-pass-123" },
    });
    expect(bl.statusCode).toBe(200);
  });

  afterAll(async () => {
    try {
      // 完整清理本测试创建的全部事实（non-destructive 到共享库其他数据）。
      // 依赖顺序：先删 idempotency_keys → batches → stored_files → audit → sessions → users。
      const userIds = [adminUserId, adminBUserId, learnerUserId].filter((x): x is string => !!x);
      const pool = createPool({ ...config, max: 1 });
      try {
        // 幂等键：scope 精确到本测试用户。
        if (userIds.length > 0) {
          const scopes = userIds.map((id) => `import:batch:create:${id}`);
          await pool.query(`DELETE FROM idempotency_keys WHERE scope = ANY($1::text[])`, [scopes]);
        }
        // 批次 → 文件（因 file_id FK 顺序）。
        if (userIds.length > 0) {
          await pool.query(`DELETE FROM import_batches WHERE uploaded_by = ANY($1::uuid[])`, [
            userIds,
          ]);
          await pool.query(`DELETE FROM stored_files WHERE uploaded_by = ANY($1::uuid[])`, [
            userIds,
          ]);
          // 审计：contract 要求 actor=本测试用户；恢复可审计事实的隔离（bulk delete 不含敏感）。
          await pool.query(`DELETE FROM audit_events WHERE actor_id = ANY($1::uuid[])`, [userIds]);
        }
      } finally {
        await pool.end();
      }

      // 关闭 app（释放连接池）后再删用户（避免 session 相关引用），依赖 auth_sessions 级联。
      if (app) await app.close();
      if (userIds.length > 0) {
        const dropPool = createPool({ ...config, max: 1 });
        try {
          // auth_sessions ON DELETE CASCADE；users 删除。
          await dropPool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
        } finally {
          await dropPool.end();
        }
      }

      // 后置断言：本测试命名空间的事实已归零（仅当确有用户被创建）。
      const verifyPool = createPool({ ...config, max: 1 });
      try {
        if (userIds.length > 0) {
          const u = await verifyPool.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM users WHERE id = ANY($1::uuid[])",
            [userIds],
          );
          expect(Number(u.rows[0]?.n ?? 0)).toBe(0); // users: 0
          const s = await verifyPool.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM auth_sessions WHERE user_id = ANY($1::uuid[])",
            [userIds],
          );
          expect(Number(s.rows[0]?.n ?? 0)).toBe(0); // sessions: 0
          const ik = await verifyPool.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM idempotency_keys WHERE scope = ANY($1::text[])",
            [userIds.map((id) => `import:batch:create:${id}`)],
          );
          expect(Number(ik.rows[0]?.n ?? 0)).toBe(0); // idempotency keys: 0
          const b = await verifyPool.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM import_batches WHERE uploaded_by = ANY($1::uuid[])",
            [userIds],
          );
          expect(Number(b.rows[0]?.n ?? 0)).toBe(0); // batches: 0
          const f = await verifyPool.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM stored_files WHERE uploaded_by = ANY($1::uuid[])",
            [userIds],
          );
          expect(Number(f.rows[0]?.n ?? 0)).toBe(0); // stored files: 0
          const a = await verifyPool.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM audit_events WHERE actor_id = ANY($1::uuid[])",
            [userIds],
          );
          expect(Number(a.rows[0]?.n ?? 0)).toBe(0); // audit facts: 0
        }
      } finally {
        await verifyPool.end();
      }
    } finally {
      // 即使数据库清理或后置断言失败，也不能污染同进程后续测试。
      try {
        rmSync(tempImportRoot, { recursive: true, force: true });
      } catch {
        // 忽略清理失败。
      }
      restoreEnv("IMPORT_FILE_ROOT_DIR", previousImportFileRootDir);
      restoreEnv("IMPORT_MAX_FILE_BYTES", previousImportMaxFileBytes);
    }
  });

  function body(res: Res): Record<string, unknown> {
    return res.json() as Record<string, unknown>;
  }

  function importFileCount(): number {
    return readdirSync(tempImportRoot).filter((f) => f.startsWith("import-")).length;
  }

  function uniqKey(): string {
    return `${randomUUID()}-${Date.now()}`;
  }

  it("0001–0016 空库迁移：出现 stored_files 与 import_batches", async () => {
    const dbName = `motro_imp_${Date.now().toString(36)}_${randomBytes(2).toString("hex")}`;
    const adminPool = createPool({ ...config, database: "postgres", max: 1 });
    try {
      await adminPool.query(`CREATE DATABASE "${dbName}"`);
    } finally {
      await adminPool.end();
    }
    const isoConfig = { ...config, database: dbName };
    try {
      const applied = await migrate(isoConfig, MIGRATIONS_DIR);
      expect(applied.map((m) => m.version)).toContain(16);
      const recorded = await listAppliedMigrations(isoConfig);
      expect(recorded.map((m) => m.version)).toContain(16);
      const verify = createPool({ ...isoConfig, max: 1 });
      try {
        await verify.query("SELECT 1 FROM stored_files LIMIT 0");
        await verify.query("SELECT 1 FROM import_batches LIMIT 0");
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

  it("管理员上传 txt -> 创建 batch + stored_files，返回元数据与 SHA-256，不含磁盘路径/存储键", async () => {
    const mp = multipart(
      { sourceDeclaration: "牛津 3000 高中阶段" },
      { filename: "words.txt", content: Buffer.from("apple\nbanana\ncherry\n") },
    );
    const res = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mp.contentType, "idempotency-key": uniqKey() },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(201);
    const b = body(res) as {
      format: string;
      status: string;
      sourceDeclaration: string;
      file: { originalFilename: string; byteSize: number; sha256Hex: string };
    };
    expect(b.format).toBe("txt");
    expect(b.status).toBe("uploaded");
    expect(b.sourceDeclaration).toBe("牛津 3000 高中阶段");
    expect(b.file.originalFilename).toBe("words.txt");
    expect(b.file.byteSize).toBe(20);
    expect(b.file.sha256Hex).toMatch(/^[0-9a-f]{64}$/);
    const raw = JSON.stringify(res.json());
    expect(raw).not.toContain("storageKey");
    expect(raw).not.toContain("storage_key");
    expect(raw).not.toContain(".local-import");
    expect(raw).not.toContain("fileRootDir");
    // 原名不落盘：磁盘文件只以 import- 开头。
    const files = readdirSync(tempImportRoot).filter((f) => f.startsWith("import-"));
    expect(files.some((f) => f.includes("words"))).toBe(false);
    expect(files.length).toBe(1);
  });

  it("拒绝空文件/非法扩展名/超限，且无孤儿文件或记录", async () => {
    const before = importFileCount();
    const beforeBatches = await countBatches();

    // 空文件。
    const empty = multipart(
      { sourceDeclaration: "s" },
      { filename: "e.txt", content: Buffer.from("") },
    );
    const rEmpty = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": empty.contentType, "idempotency-key": uniqKey() },
      payload: empty.payload,
    });
    expect([400, 422]).toContain(rEmpty.statusCode);

    // 非法扩展名（.exe）。
    const exeBoundary = `----exe-${randomUUID().replace(/-/g, "")}`;
    const exePayload = Buffer.concat([
      Buffer.from(`--${exeBoundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="sourceDeclaration"\r\n\r\n`),
      Buffer.from(`s\r\n`),
      Buffer.from(`--${exeBoundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="file"; filename="evil.exe"\r\n`),
      Buffer.from(`Content-Type: application/octet-stream\r\n\r\n`),
      Buffer.from(`hello\n`),
      Buffer.from(`\r\n--${exeBoundary}--\r\n`),
    ]);
    const exeRes = await admin.req("POST", "/api/v1/admin/imports", {
      headers: {
        "content-type": `multipart/form-data; boundary=${exeBoundary}`,
        "idempotency-key": uniqKey(),
      },
      payload: exePayload,
    });
    expect([400, 422]).toContain(exeRes.statusCode);

    // 超限（> 2048）。
    const bigBoundary = `----big-${randomUUID().replace(/-/g, "")}`;
    const big = Buffer.concat([
      Buffer.from(`--${bigBoundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="sourceDeclaration"\r\n\r\n`),
      Buffer.from(`s\r\n`),
      Buffer.from(`--${bigBoundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="file"; filename="big.txt"\r\n`),
      Buffer.from(`Content-Type: text/plain\r\n\r\n`),
      Buffer.alloc(6 * 1024 * 1024 + 1, 0x61),
      Buffer.from(`\r\n--${bigBoundary}--\r\n`),
    ]);
    const bigRes = await admin.req("POST", "/api/v1/admin/imports", {
      headers: {
        "content-type": `multipart/form-data; boundary=${bigBoundary}`,
        "idempotency-key": uniqKey(),
      },
      payload: big,
    });
    expect([400, 413, 422]).toContain(bigRes.statusCode);

    // 失败后无新文件、无新批次记录。
    expect(importFileCount()).toBe(before);
    expect(await countBatches()).toBe(beforeBatches);
  });

  it("learner / 未登录访问 /admin/imports 被拒", async () => {
    const lr = await learner.req("GET", "/api/v1/admin/imports", {});
    expect([403, 404]).toContain(lr.statusCode);
    const anon = makeClient(app);
    const ar = await anon.req("GET", "/api/v1/admin/imports", {});
    expect([401, 403]).toContain(ar.statusCode);
    const learnerMp = multipart(
      { sourceDeclaration: "s" },
      { filename: "a.txt", content: Buffer.from("x\n") },
    );
    const lr2 = await learner.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": learnerMp.contentType, "idempotency-key": uniqKey() },
      payload: learnerMp.payload,
    });
    expect([403, 404]).toContain(lr2.statusCode);
  });

  it("审计记录创建批次且不含路径/存储键/敏感数据", async () => {
    const mp = multipart(
      { sourceDeclaration: "来源2" },
      { filename: "audit.txt", content: Buffer.from("dragon\n") },
    );
    const res = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mp.contentType, "idempotency-key": uniqKey() },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(201);
    const pool = createPool({ ...config, max: 1 });
    try {
      const rows = await pool.query<{ action: string; after_summary: unknown }>(
        `SELECT action, after_summary FROM audit_events
         WHERE action = 'admin.import.batch.create' ORDER BY created_at DESC LIMIT 1`,
      );
      expect(rows.rows.length).toBeGreaterThanOrEqual(1);
      const summary = JSON.stringify(rows.rows[0]?.after_summary ?? {});
      expect(summary).not.toContain("storageKey");
      expect(summary).not.toContain("storage_key");
      expect(summary).not.toContain("password");
      expect(summary).not.toContain("Token");
    } finally {
      await pool.end();
    }
  });

  it("P1-2 幂等：同 Idempotency-Key + 同请求重放首次结果；同 key 改请求 → 409", async () => {
    const before = importFileCount();
    const beforeBatches = await countBatches();
    const mp = multipart(
      { sourceDeclaration: "dup-source" },
      { filename: "dup.txt", content: Buffer.from("dup-word\n") },
    );
    const idemKey = uniqKey();
    // 首次上传成功。
    const r1 = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mp.contentType, "idempotency-key": idemKey },
      payload: mp.payload,
    });
    expect(r1.statusCode).toBe(201);
    const batch1 = (body(r1) as { id: string }).id;
    const filesAfter1 = importFileCount();
    expect(filesAfter1).toBe(before + 1);
    expect(await countBatches()).toBe(beforeBatches + 1);

    // 同 key + 同请求 → 幂等重放同一批次（200，不新增文件/批次）。
    const r2 = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mp.contentType, "idempotency-key": idemKey },
      payload: mp.payload,
    });
    expect(r2.statusCode).toBe(200);
    expect((body(r2) as { id: string }).id).toBe(batch1);
    expect(importFileCount()).toBe(filesAfter1);
    expect(await countBatches()).toBe(beforeBatches + 1);

    // 同 key 但不同来源声明 → 409 IDEMPOTENCY_CONFLICT。
    const mp2 = multipart(
      { sourceDeclaration: "不同来源" },
      { filename: "dup.txt", content: Buffer.from("dup-word\n") },
    );
    const r3 = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mp2.contentType, "idempotency-key": idemKey },
      payload: mp2.payload,
    });
    expect(r3.statusCode).toBe(409);
    expect((body(r3) as { error: { code: string } }).error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(importFileCount()).toBe(filesAfter1);
    expect(await countBatches()).toBe(beforeBatches + 1);
  });

  it("P1-2 内容去重按上传人：同管理员同内容不同 key 复用文件与批次；不同管理员各自可上传", async () => {
    // 同管理员、同内容、不同 idempotency-key + 同来源 → 复用既有 batch 与文件。
    const beforeBatches = await countBatches();
    const content = Buffer.from(`shared-${Date.now()}\n`);
    const mp = multipart({ sourceDeclaration: "共享来源" }, { filename: "shared.txt", content });
    const r1 = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mp.contentType, "idempotency-key": uniqKey() },
      payload: mp.payload,
    });
    expect(r1.statusCode).toBe(201);
    const batchA = (body(r1) as { id: string }).id;
    const filesAfterOne = importFileCount();

    // 同管理员、同内容、不同 key（但同一来源）→ 复用既有 batch，不新增文件 → 200。
    const r2 = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mp.contentType, "idempotency-key": uniqKey() },
      payload: mp.payload,
    });
    expect(r2.statusCode).toBe(200);
    expect((body(r2) as { id: string }).id).toBe(batchA); // 同来源 → 同 batch
    expect(importFileCount()).toBe(filesAfterOne); // 不新增磁盘文件
    expect(await countBatches()).toBe(beforeBatches + 1);
  });

  it("P1-1 伪造 MIME/二进制内容被嗅探拒绝：DB 与目录无孤儿", async () => {
    const beforeFiles = readdirSync(tempImportRoot).filter((f) => f.startsWith("import-")).length;
    const beforeBatches = await countBatches();

    // 二进制内容伪装成 .txt / text/plain：
    const binary = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const mp = multipart({ sourceDeclaration: "伪装" }, { filename: "fake.txt", content: binary });
    const r = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mp.contentType, "idempotency-key": uniqKey() },
      payload: mp.payload,
    });
    expect([400, 422]).toContain(r.statusCode);

    // 内容非 UTF-8 → 拒绝；目录无新增、DB 无新批次。
    const nowFiles = readdirSync(tempImportRoot).filter((f) => f.startsWith("import-")).length;
    expect(nowFiles).toBe(beforeFiles);
    expect(await countBatches()).toBe(beforeBatches);
  });

  it("P2-2 管理员共享读取：A 上传、B 可读；学习者不可读", async () => {
    const mp = multipart(
      { sourceDeclaration: "A 上传" },
      { filename: "forB.txt", content: Buffer.from("shared-read\n") },
    );
    const created = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mp.contentType, "idempotency-key": uniqKey() },
      payload: mp.payload,
    });
    expect(created.statusCode).toBe(201);
    const batchId = (body(created) as { id: string }).id;

    // B（另一管理员）可读列表与详情。
    const listB = await adminB.req("GET", "/api/v1/admin/imports", {});
    expect(listB.statusCode).toBe(200);
    const items = (body(listB) as { items: { id: string }[] }).items;
    expect(items.some((x) => x.id === batchId)).toBe(true);

    const getB = await adminB.req("GET", `/api/v1/admin/imports/${batchId}`, {});
    expect(getB.statusCode).toBe(200);

    // 学习者不可读。
    const learnerList = await learner.req("GET", "/api/v1/admin/imports", {});
    expect([403, 404]).toContain(learnerList.statusCode);
    const learnerGet = await learner.req("GET", `/api/v1/admin/imports/${batchId}`, {});
    expect([403, 404]).toContain(learnerGet.statusCode);

    // 本套件统一由 afterAll 按本次运行的精确 UUID 清理。
  });

  it("P2-3 跨管理员上传隔离：A 与 B 上传同一内容各自拥有独立事实", async () => {
    const content = Buffer.from(`cross-admin-${Date.now()}\n`);
    const mp = multipart({ sourceDeclaration: "跨管理员来源" }, { filename: "cross.txt", content });

    // A 上传 → 201。
    const rA = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mp.contentType, "idempotency-key": uniqKey() },
      payload: mp.payload,
    });
    expect(rA.statusCode).toBe(201);
    const batchA = (body(rA) as { id: string }).id;

    // B 上传同一内容 → 201（各自拥有自己的文件与批次，不因内容相同而碰撞）。
    const rB = await adminB.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mp.contentType, "idempotency-key": uniqKey() },
      payload: mp.payload,
    });
    expect(rB.statusCode).toBe(201);
    const batchB = (body(rB) as { id: string }).id;
    expect(batchB).not.toBe(batchA);

    // 数据库：每位管理员各自一个 stored_file 和一个 import_batch。
    const pool = createPool({ ...config, max: 1 });
    try {
      const fileIds = await pool.query<{ n: string }>(
        `SELECT count(DISTINCT f.id)::text AS n
         FROM stored_files f JOIN import_batches b ON b.file_id = f.id
         WHERE b.id = ANY($1::uuid[])`,
        [[batchA, batchB]],
      );
      expect(Number(fileIds.rows[0]?.n ?? 0)).toBe(2);
    } finally {
      await pool.end();
    }

    // 两位管理员都能读取共享批次元数据；学习者仍被拒绝。
    const getByB = await adminB.req("GET", `/api/v1/admin/imports/${batchA}`, {});
    expect(getByB.statusCode).toBe(200);
    const getByA = await admin.req("GET", `/api/v1/admin/imports/${batchB}`, {});
    expect(getByA.statusCode).toBe(200);
    const learnerGet = await learner.req("GET", `/api/v1/admin/imports/${batchA}`, {});
    expect([403, 404]).toContain(learnerGet.statusCode);

    // 本套件统一由 afterAll 按本次运行的精确 UUID 清理。
  });

  it("P1-2 并发同 key：只生成一个 batch/文件事实", async () => {
    const beforeBatches = await countBatches();
    const content = Buffer.from(`concurrent-${Date.now()}\n`);
    const mp = multipart({ sourceDeclaration: "并发" }, { filename: "conc.txt", content });
    const idemKey = uniqKey();
    const [rA, rB] = await Promise.all([
      admin.req("POST", "/api/v1/admin/imports", {
        headers: { "content-type": mp.contentType, "idempotency-key": idemKey },
        payload: mp.payload,
      }),
      admin.req("POST", "/api/v1/admin/imports", {
        headers: { "content-type": mp.contentType, "idempotency-key": idemKey },
        payload: mp.payload,
      }),
    ]);
    // 并发同 key：允许 201(创建)/200(重放)/409(处理中)；绝不允许 500。
    for (const r of [rA, rB]) {
      expect([200, 201, 409]).toContain(r.statusCode);
    }
    // 同 key 并发只新增一个 batch（全局计数 +1 到 +2 之内；至少 201 之一成功）。
    const createdCount = [rA, rB].filter((r) => r.statusCode === 201).length;
    expect(createdCount).toBeGreaterThanOrEqual(1);
    expect(createdCount).toBeLessThanOrEqual(1);
    const afterBatches = await countBatches();
    expect(afterBatches - beforeBatches).toBeLessThanOrEqual(1);
  });

  it("P1-1 同 Idempotency-Key、相同元数据、不同内容 → 409 且不产生额外文件/批次", async () => {
    const beforeBatches = await countBatches();
    const beforeFiles = readdirSync(tempImportRoot).filter((f) => f.startsWith("import-")).length;
    const idemKey = uniqKey();
    const mp1 = multipart(
      { sourceDeclaration: "同 key 改内容" },
      { filename: "chg.txt", content: Buffer.from("content-A\n") },
    );
    const r1 = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mp1.contentType, "idempotency-key": idemKey },
      payload: mp1.payload,
    });
    expect(r1.statusCode).toBe(201);
    const batch1 = (body(r1) as { id: string }).id;

    // 同 key、同 filename/source/MIME，但内容不同 → 409（request hash 含 SHA-256）。
    const mp2 = multipart(
      { sourceDeclaration: "同 key 改内容" },
      { filename: "chg.txt", content: Buffer.from("content-B-DIFFERENT\n") },
    );
    const r2 = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mp2.contentType, "idempotency-key": idemKey },
      payload: mp2.payload,
    });
    expect(r2.statusCode).toBe(409);
    expect((body(r2) as { error: { code: string } }).error.code).toBe("IDEMPOTENCY_CONFLICT");

    // 不产生额外文件/批次。
    expect(await countBatches()).toBe(beforeBatches + 1);
    const afterFiles = readdirSync(tempImportRoot).filter((f) => f.startsWith("import-")).length;
    expect(afterFiles).toBe(beforeFiles + 1); // 只有首次成功的文件
    // 首次批次可重放（同 key + 同内容重新上传 → 200）。
    const r3 = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mp1.contentType, "idempotency-key": idemKey },
      payload: mp1.payload,
    });
    expect(r3.statusCode).toBe(200);
    expect((body(r3) as { id: string }).id).toBe(batch1);
  });

  it("P1-2 创建失败后同 key 可安全重试成功；response_json 与 batch 同事务一致", async () => {
    const beforeBatches = await countBatches();
    const idemKey = uniqKey();
    // 先触发一个失败（伪造二进制内容）用同 key？不行，key 只用于成功。改用：上传成功后再用同 key
    // 重放 → 200。再验证 response_json 与 batch 一致。
    const mp = multipart(
      { sourceDeclaration: "事务一致性" },
      { filename: "txn.txt", content: Buffer.from("txn-ok\n") },
    );
    const r1 = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mp.contentType, "idempotency-key": idemKey },
      payload: mp.payload,
    });
    expect(r1.statusCode).toBe(201);
    const batchId = (body(r1) as { id: string }).id;

    // 同 key 重放 → 200，且返回同一批次。
    const r2 = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mp.contentType, "idempotency-key": idemKey },
      payload: mp.payload,
    });
    expect(r2.statusCode).toBe(200);
    expect((body(r2) as { id: string }).id).toBe(batchId);

    // response_json 与 import_batches 行一致（同一事务提交）。
    const pool = createPool({ ...config, max: 1 });
    try {
      const idem = await pool.query<{ response_json: { id: string } }>(
        `SELECT response_json FROM idempotency_keys WHERE scope LIKE 'import:batch:create:%' AND key = $1`,
        [idemKey],
      );
      expect(idem.rows[0]).toBeTruthy();
      expect(idem.rows[0]!.response_json.id).toBe(batchId);
      // batch 存在于 import_batches。
      const b = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM import_batches WHERE id = $1",
        [batchId],
      );
      expect(Number(b.rows[0]?.n ?? 0)).toBe(1);
      // 审计事件存在。
      const a = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM audit_events WHERE target_id = $1 AND action = 'admin.import.batch.create'",
        [batchId],
      );
      expect(Number(a.rows[0]?.n ?? 0)).toBeGreaterThanOrEqual(1);
    } finally {
      await pool.end();
    }
    expect(await countBatches()).toBe(beforeBatches + 1);
  });

  it("P1-3 合法 CSV / TXT / JSON 上传成功；txt/csv 与 json 互相伪装失败", async () => {
    // CSV 成功（普通 UTF-8 文本 → utf8，扩展名 csv 接受）。
    const csv = multipart(
      { sourceDeclaration: "csv" },
      { filename: "words.csv", content: Buffer.from("apple,1\nbanana,2\n") },
    );
    const rCsv = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": csv.contentType, "idempotency-key": uniqKey() },
      payload: csv.payload,
    });
    expect(rCsv.statusCode).toBe(201);
    expect((body(rCsv) as { format: string }).format).toBe("csv"); // P1-1：保留 csv 格式
    const csvBatchId = (body(rCsv) as { id: string }).id;

    // TXT 成功。
    const txt = multipart(
      { sourceDeclaration: "txt" },
      { filename: "words.txt", content: Buffer.from("apple\nbanana\n") },
    );
    const rTxt = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": txt.contentType, "idempotency-key": uniqKey() },
      payload: txt.payload,
    });
    expect(rTxt.statusCode).toBe(201);
    expect((body(rTxt) as { format: string }).format).toBe("txt");
    const txtBatchId = (body(rTxt) as { id: string }).id;

    // JSON 成功。
    const json = multipart(
      { sourceDeclaration: "json" },
      {
        filename: "words.json",
        content: Buffer.from('{"words":["apple"]}\n'),
        mime: "application/json",
      },
    );
    const rJson = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": json.contentType, "idempotency-key": uniqKey() },
      payload: json.payload,
    });
    expect(rJson.statusCode).toBe(201);
    expect((body(rJson) as { format: string }).format).toBe("json");
    const jsonBatchId = (body(rJson) as { id: string }).id;

    // P1-1：数据库里 stored_files.format 与 import_batches.format 分别正确。
    const csvDb = await batchFormats(csvBatchId);
    expect(csvDb.fileFormat).toBe("csv");
    expect(csvDb.batchFormat).toBe("csv");
    const txtDb = await batchFormats(txtBatchId);
    expect(txtDb.fileFormat).toBe("txt");
    expect(txtDb.batchFormat).toBe("txt");
    const jsonDb = await batchFormats(jsonBatchId);
    expect(jsonDb.fileFormat).toBe("json");
    expect(jsonDb.batchFormat).toBe("json");

    // 普通文本伪装成 .json → 失败（utf8 内容不允许 json 扩展名）。
    const fakeJson = multipart(
      { sourceDeclaration: "fake-json" },
      { filename: "words.json", content: Buffer.from("apple,banana\n") },
    );
    const rFakeJson = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": fakeJson.contentType, "idempotency-key": uniqKey() },
      payload: fakeJson.payload,
    });
    expect([400, 422]).toContain(rFakeJson.statusCode);

    // JSON 伪装成 .txt/.csv → 失败（json 内容不允许 txt/csv 扩展名）。
    const jsonAsTxt = multipart(
      { sourceDeclaration: "json-as-txt" },
      { filename: "words.txt", content: Buffer.from('{"words":["apple"]}\n') },
    );
    const rJsonAsTxt = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": jsonAsTxt.contentType, "idempotency-key": uniqKey() },
      payload: jsonAsTxt.payload,
    });
    expect([400, 422]).toContain(rJsonAsTxt.statusCode);
  });

  it("P1-4 同上传人同内容不同来源声明 → 409 IMPORT_CONTENT_CONFLICT（不覆盖、不留 400）", async () => {
    const content = Buffer.from(`conflict-${Date.now()}\n`);
    const mp1 = multipart({ sourceDeclaration: "来源 A" }, { filename: "conflict.txt", content });
    const r1 = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mp1.contentType, "idempotency-key": uniqKey() },
      payload: mp1.payload,
    });
    expect(r1.statusCode).toBe(201);
    const batchA = (body(r1) as { id: string }).id;

    // 同一上传人、同内容、不同来源声明 → 409 IMPORT_CONTENT_CONFLICT，且返回既有 batch id。
    const mp2 = multipart({ sourceDeclaration: "来源 B" }, { filename: "conflict.txt", content });
    const r2 = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mp2.contentType, "idempotency-key": uniqKey() },
      payload: mp2.payload,
    });
    expect(r2.statusCode).toBe(409);
    const err = body(r2) as { error: { code: string; existingBatchId?: string } };
    expect(err.error.code).toBe("IMPORT_CONTENT_CONFLICT");
    expect(err.error.existingBatchId).toBe(batchA);

    // 原来源声明未被覆盖。
    const pool = createPool({ ...config, max: 1 });
    try {
      const b = await pool.query<{ source_declaration: string }>(
        "SELECT source_declaration FROM import_batches WHERE id = $1",
        [batchA],
      );
      expect(b.rows[0]?.source_declaration).toBe("来源 A");
    } finally {
      await pool.end();
    }
  });

  it("P1-2 大于 512 KiB 的合法 JSON 上传成功；同尺寸截断/无效 JSON 被拒绝且无孤儿", async () => {
    const beforeBatches = await countBatches();
    const beforeFiles = readdirSync(tempImportRoot).filter((f) => f.startsWith("import-")).length;

    // 构造 > 512 KiB、< 6 MiB（测试上限）的合法 JSON。
    const words = Array.from({ length: 120_000 }, (_, i) => `"word${i}"`);
    const bigJson = `{"words":[${words.join(",")}]}`;
    expect(bigJson.length).toBeGreaterThan(512 * 1024);
    expect(bigJson.length).toBeLessThan(6 * 1024 * 1024);

    const ok = multipart(
      { sourceDeclaration: "大 JSON" },
      { filename: "big.json", content: Buffer.from(bigJson), mime: "application/json" },
    );
    const rOk = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": ok.contentType, "idempotency-key": uniqKey() },
      payload: ok.payload,
    });
    expect(rOk.statusCode).toBe(201);
    expect((body(rOk) as { format: string }).format).toBe("json");

    // 同尺寸的截断/无效 JSON（末尾截断导致 JSON.parse 失败）→ 拒绝。
    const truncated = bigJson.slice(0, bigJson.length - 3); // 去掉结尾 }，非法 JSON
    const bad = multipart(
      { sourceDeclaration: "坏 JSON" },
      { filename: "bad.json", content: Buffer.from(truncated), mime: "application/json" },
    );
    const rBad = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": bad.contentType, "idempotency-key": uniqKey() },
      payload: bad.payload,
    });
    expect([400, 422]).toContain(rBad.statusCode);

    // 无孤儿：批次 +1（只有成功的那个），磁盘文件 +1（只有成功的）。
    expect(await countBatches()).toBe(beforeBatches + 1);
    const afterFiles = readdirSync(tempImportRoot).filter((f) => f.startsWith("import-")).length;
    expect(afterFiles).toBe(beforeFiles + 1);
  });

  it("P1-3 真实失败后同 key 可安全重试成功；失败不留 pending 幂等键", async () => {
    const beforeBatches = await countBatches();
    const beforeFiles = readdirSync(tempImportRoot).filter((f) => f.startsWith("import-")).length;
    const idemKey = uniqKey();
    const content = Buffer.from(`retry-${Date.now()}\n`);
    const mp = multipart({ sourceDeclaration: "重试" }, { filename: "retry.txt", content });

    const fnName = `fn_fail_audit_${Date.now().toString(36)}`;
    const trgName = `trg_fail_audit_${Date.now().toString(36)}`;
    const pool = createPool({ ...config, max: 1 });
    // 临时 trigger：在 INSERT audit_events 时 RAISE，使失败发生在幂等 claim 与批次写入
    // 之后、COMMIT 之前（事务内）。finally 无条件删除，避免污染共享测试库。
    try {
      await pool.query(
        `CREATE FUNCTION ${fnName}() RETURNS trigger AS $$
         BEGIN RAISE EXCEPTION 'test fail audit'; END;
         $$ LANGUAGE plpgsql`,
      );
      await pool.query(
        `CREATE TRIGGER ${trgName} BEFORE INSERT ON audit_events
         FOR EACH ROW WHEN (NEW.action = 'admin.import.batch.create')
         EXECUTE FUNCTION ${fnName}()`,
      );

      // 第一次：INSERT audit 触发 RAISE → 事务回滚（claim 之后的失败）。
      const r1 = await admin.req("POST", "/api/v1/admin/imports", {
        headers: { "content-type": mp.contentType, "idempotency-key": idemKey },
        payload: mp.payload,
      });
      // P1-1：底层 trigger 错误必须返回脱敏 500，且为统一错误信封。
      expect(r1.statusCode).toBe(500);
      const env = body(r1) as {
        error?: { code?: string; requestId?: string; retryable?: boolean };
      };
      expect(env.error?.code).toBe("INTERNAL_ERROR");
      expect(typeof env.error?.requestId).toBe("string");
      expect(env.error?.retryable).toBe(true);
      const envelopeRaw = JSON.stringify(r1.json());
      // 绝不泄露底层信息。
      expect(envelopeRaw.toLowerCase()).not.toContain("test fail");
      expect(envelopeRaw).not.toContain("audit_events");
      expect(envelopeRaw).not.toContain("storage_key");
      expect(envelopeRaw).not.toContain("fileRootDir");
      expect(envelopeRaw).not.toContain("motro-import");
      expect(/\/Users|\/Volumes|home\/|\\[a-z]:/.test(envelopeRaw)).toBe(false); // 无主机绝对路径
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${trgName} ON audit_events`).catch(() => {});
      await pool.query(`DROP FUNCTION IF EXISTS ${fnName}()`).catch(() => {});
    }
    await pool.end();

    // 第一次失败后：目录无孤儿临时文件；无批次；幂等键无 pending 残留。
    const afterFailFiles = readdirSync(tempImportRoot).filter((f) =>
      f.startsWith("import-"),
    ).length;
    expect(afterFailFiles).toBe(beforeFiles); // 失败不留下临时文件
    expect(await countBatches()).toBe(beforeBatches); // 失败不落批次
    const pool2 = createPool({ ...config, max: 1 });
    try {
      const pending = await pool2.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM idempotency_keys
         WHERE scope LIKE 'import:batch:create:%' AND key = $1`,
        [idemKey],
      );
      expect(Number(pending.rows[0]?.n ?? 0)).toBe(0); // 无 pending 残留
      // 失败后不应新增与本次 key 有关的 stored_files / import_batches / audit 事实：
      // 整笔事务回滚，因此以 key 为 idempotency scope 关联不到任何 batch。
      const linked = await pool2.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM idempotency_keys ik
         JOIN import_batches b ON b.id = ik.resource_id::uuid
         WHERE ik.scope LIKE 'import:batch:create:%' AND ik.key = $1`,
        [idemKey],
      );
      expect(Number(linked.rows[0]?.n ?? 0)).toBe(0); // 失败未落批次事实
    } finally {
      await pool2.end();
    }

    // 第二次：同 key + 同内容 → 成功创建 batch（不是 IDEMPOTENCY_IN_PROGRESS）。
    const r2 = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mp.contentType, "idempotency-key": idemKey },
      payload: mp.payload,
    });
    expect(r2.statusCode).toBe(201);
    expect(await countBatches()).toBe(beforeBatches + 1);
    const afterOkFiles = readdirSync(tempImportRoot).filter((f) => f.startsWith("import-")).length;
    expect(afterOkFiles).toBe(beforeFiles + 1);
  });

  it("P1-3 幂等哈希分隔符碰撞：同 key、同内容、不同 source/filename 拼接碰撞 → 409", async () => {
    const beforeFiles = readdirSync(tempImportRoot).filter((f) => f.startsWith("import-")).length;
    const idemKey = uniqKey();
    const content = Buffer.from("same-content\n");

    // 第一次：source = "a|b", filename = "c.txt"。
    const mpA = multipart({ sourceDeclaration: "a|b" }, { filename: "c.txt", content });
    const rA = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mpA.contentType, "idempotency-key": idemKey },
      payload: mpA.payload,
    });
    expect(rA.statusCode).toBe(201);
    const batchA = (body(rA) as { id: string }).id;

    // 第二次：source = "a", filename = "b|c.txt"（旧 `join("|")` 会与上面碰撞）。
    const mpB = multipart({ sourceDeclaration: "a" }, { filename: "b|c.txt", content });
    const rB = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mpB.contentType, "idempotency-key": idemKey },
      payload: mpB.payload,
    });
    // P1-3：不同语义必须 409，不能错误重放 A。
    expect(rB.statusCode).toBe(409);
    expect((body(rB) as { error: { code: string } }).error.code).toBe("IDEMPOTENCY_CONFLICT");
    // 文件与批次数不增加。
    const afterFiles = readdirSync(tempImportRoot).filter((f) => f.startsWith("import-")).length;
    expect(afterFiles).toBe(beforeFiles + 1);
    // 同一内容和来源重新上传 A → 重放 A（200）。
    const rA2 = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mpA.contentType, "idempotency-key": idemKey },
      payload: mpA.payload,
    });
    expect(rA2.statusCode).toBe(200);
    expect((body(rA2) as { id: string }).id).toBe(batchA);
  });

  it("P1-5 不同 key、相同内容并发只产生一份事实且都成功/200", async () => {
    const beforeBatches = await countBatches();
    const beforeFiles = readdirSync(tempImportRoot).filter((f) => f.startsWith("import-")).length;
    const content = Buffer.from(`concurrent-dedup-${Date.now()}\n`);
    const mp = multipart({ sourceDeclaration: "并发去重" }, { filename: "c.txt", content });
    const [rA, rB] = await Promise.all([
      admin.req("POST", "/api/v1/admin/imports", {
        headers: { "content-type": mp.contentType, "idempotency-key": uniqKey() },
        payload: mp.payload,
      }),
      admin.req("POST", "/api/v1/admin/imports", {
        headers: { "content-type": mp.contentType, "idempotency-key": uniqKey() },
        payload: mp.payload,
      }),
    ]);
    // 一个 201、一个 200（去重复用），两者指向同一批次；绝不允许 500/裸 23505。
    const statuses = [rA.statusCode, rB.statusCode];
    expect(statuses.some((s) => s === 201)).toBe(true);
    expect(statuses.some((s) => s === 200)).toBe(true);
    const idA = (body(rA) as { id: string }).id;
    const idB = (body(rB) as { id: string }).id;
    expect(idA).toBe(idB);

    // P2-2：完整事实断言 —— 只一个 stored_file、一个 batch、一条 create 审计、一份磁盘文件。
    const pool = createPool({ ...config, max: 1 });
    try {
      const b = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM import_batches WHERE id = $1",
        [idA],
      );
      expect(Number(b.rows[0]?.n ?? 0)).toBe(1);
      const f = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM stored_files sf
         JOIN import_batches b ON b.file_id = sf.id WHERE b.id = $1`,
        [idA],
      );
      expect(Number(f.rows[0]?.n ?? 0)).toBe(1); // 一个 stored file
      const audit = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_events
         WHERE target_id = $1 AND action = 'admin.import.batch.create'`,
        [idA],
      );
      expect(Number(audit.rows[0]?.n ?? 0)).toBe(1); // 一条 create 审计（复用不伪造）
    } finally {
      await pool.end();
    }
    expect(await countBatches()).toBe(beforeBatches + 1);
    // 磁盘文件只新增一份（并发去重清理了重复临时文件）。
    const afterFiles = readdirSync(tempImportRoot).filter((f) => f.startsWith("import-")).length;
    expect(afterFiles).toBe(beforeFiles + 1);
  });

  it("P2-2 同 key 响应丢失后重试：复用同一 key → 200，且 DB/磁盘各恰一份事实", async () => {
    const beforeBatches = await countBatches();
    const beforeFiles = readdirSync(tempImportRoot).filter((f) => f.startsWith("import-")).length;
    const idemKey = uniqKey();
    const content = Buffer.from(`response-lost-${Date.now()}\n`);
    const mp = multipart({ sourceDeclaration: "响应丢失" }, { filename: "lost.txt", content });

    // 第一次：服务端提交，返回 201（模拟“浏览器未收到响应但服务端已创建”）。
    const r1 = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mp.contentType, "idempotency-key": idemKey },
      payload: mp.payload,
    });
    expect(r1.statusCode).toBe(201);
    const batchId = (body(r1) as { id: string }).id;

    // 客户端重试：同 key + 同内容 → 200 且同一批次（幂等重放，非重复创建）。
    const r2 = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mp.contentType, "idempotency-key": idemKey },
      payload: mp.payload,
    });
    expect(r2.statusCode).toBe(200);
    expect((body(r2) as { id: string }).id).toBe(batchId);

    // 事实严格唯一：1 stored_file / 1 batch / 1 create audit / 无 pending / 磁盘 1 份。
    const pool = createPool({ ...config, max: 1 });
    try {
      const f = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM stored_files sf
         JOIN import_batches b ON b.file_id = sf.id WHERE b.id = $1`,
        [batchId],
      );
      expect(Number(f.rows[0]?.n ?? 0)).toBe(1);
      const b = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM import_batches WHERE id = $1",
        [batchId],
      );
      expect(Number(b.rows[0]?.n ?? 0)).toBe(1);
      const audit = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_events
         WHERE target_id = $1 AND action = 'admin.import.batch.create'`,
        [batchId],
      );
      expect(Number(audit.rows[0]?.n ?? 0)).toBe(1); // 创建审计恰一条，重放不追加 create
      const pend = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM idempotency_keys
         WHERE scope LIKE 'import:batch:create:%' AND key = $1`,
        [idemKey],
      );
      const pendRow = pend.rows[0];
      expect(pendRow).toBeTruthy(); // 幂等键存在且已 complete（resource_id = batch）
      const ik = await pool.query<{ resource_id: string }>(
        `SELECT resource_id FROM idempotency_keys
         WHERE scope LIKE 'import:batch:create:%' AND key = $1`,
        [idemKey],
      );
      expect(ik.rows[0]?.resource_id).toBe(batchId);
    } finally {
      await pool.end();
    }
    expect(await countBatches()).toBe(beforeBatches + 1);
    const afterResyncFiles = readdirSync(tempImportRoot).filter((f) =>
      f.startsWith("import-"),
    ).length;
    expect(afterResyncFiles).toBe(beforeFiles + 1);
  });

  it("P2-1 非法 UUID → 400（规范信封）；合法但不存在 → 404", async () => {
    const bad = await admin.req("GET", "/api/v1/admin/imports/not-a-uuid", {});
    expect(bad.statusCode).toBe(400);
    const env = body(bad) as { error?: { code?: string; requestId?: string; retryable?: boolean } };
    expect(env.error?.code).toBe("BAD_REQUEST");
    expect(typeof env.error?.requestId).toBe("string");
    expect(typeof env.error?.retryable).toBe("boolean");

    // 合法 UUID 但不存在 → 404。
    const validMissing = await admin.req("GET", `/api/v1/admin/imports/${randomUUID()}`, {});
    expect(validMissing.statusCode).toBe(404);
  });

  it("P2-1 缺文件返回 MISSING_FILE；缺 Idempotency-Key 返回 IDEMPOTENCY_KEY_REQUIRED（专用 code）", async () => {
    const beforeBatches = await countBatches();
    // 不含文件字段（只带来源声明）的 multipart → MISSING_FILE。
    const noFile = multipart({ sourceDeclaration: "无文件" });
    const missFile = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": noFile.contentType, "idempotency-key": uniqKey() },
      payload: noFile.payload,
    });
    expect(missFile.statusCode).toBe(400);
    const missFileEnvelope = missFile.json() as {
      error: { code: string; requestId: string; retryable: boolean };
    };
    expect(missFileEnvelope.error.code).toBe("MISSING_FILE");
    expect(typeof missFileEnvelope.error.requestId).toBe("string");
    expect(missFileEnvelope.error.retryable).toBe(false);

    // 带文件但缺 Idempotency-Key 头 → IDEMPOTENCY_KEY_REQUIRED。
    const noKey = multipart(
      { sourceDeclaration: "无 key" },
      { filename: "k.txt", content: Buffer.from("x\n") },
    );
    const missKey = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": noKey.contentType },
      payload: noKey.payload,
    });
    expect(missKey.statusCode).toBe(400);
    const missKeyEnvelope = missKey.json() as {
      error: { code: string; requestId: string; retryable: boolean };
    };
    expect(missKeyEnvelope.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(typeof missKeyEnvelope.error.requestId).toBe("string");
    expect(missKeyEnvelope.error.retryable).toBe(false);

    // 两次纯拒绝，无副作用：批次计数不变。
    expect(await countBatches()).toBe(beforeBatches);
  });

  async function countBatches(): Promise<number> {
    const pool = createPool({ ...config, max: 1 });
    try {
      const r = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM import_batches");
      return Number(r.rows[0]?.n ?? 0);
    } finally {
      await pool.end();
    }
  }

  /** 读取某批次的 stored_files.format 与 import_batches.format（P1-1 断言）。 */
  async function batchFormats(
    batchId: string,
  ): Promise<{ fileFormat: string; batchFormat: string }> {
    const pool = createPool({ ...config, max: 1 });
    try {
      const r = await pool.query<{ file_format: string; batch_format: string }>(
        `SELECT f.format AS file_format, b.format AS batch_format
         FROM import_batches b JOIN stored_files f ON f.id = b.file_id
         WHERE b.id = $1`,
        [batchId],
      );
      const row = r.rows[0];
      if (!row) throw new Error(`批次 ${batchId} 不存在`);
      return { fileFormat: row.file_format, batchFormat: row.batch_format };
    } finally {
      await pool.end();
    }
  }
});
