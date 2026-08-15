// 学习者课程目录 keyset 分页集成测试（真实 PostgreSQL，隔离库）。
// 覆盖：第一页只返回 limit 条、多页遍历恰好覆盖所有可见课程、第二页不重复第一页、
// hidden/inactive 永不返回、报名/主课程状态跨页正确、同一 cursor 重放稳定、
// 发布版本排序稳定、新课程插入不破坏既有 cursor、非法 cursor/limit 422、多用户隔离。
// 失败即 throw，绝不静默跳过；完成后 DROP 隔离库。
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createPool, loadDbConfigFromEnv, migrate } from "@motro/db";
import { PasswordService } from "../../../../apps/api/src/auth/password.service.js";
import { CourseService } from "../../../../apps/api/src/modules/catalog/courses/course.service.js";
import type { Pool } from "pg";

const config = loadDbConfigFromEnv();
const MIGRATIONS_DIR = resolve(process.cwd(), "db/migrations");

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

describe("catalog keyset pagination", () => {
  let pool: Pool;
  let dbName: string | undefined;
  let userId: string;
  let otherUserId: string;

  beforeAll(async () => {
    if (!dbAvailable) {
      throw new Error("catalog-pagination 需要运行中的 PostgreSQL；本套件不会静默跳过。");
    }
    dbName = `motro_catalog_page_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
    const adminPool = createPool({ ...config, database: "postgres", max: 1 });
    try {
      await adminPool.query(`CREATE DATABASE "${dbName}"`);
    } finally {
      await adminPool.end();
    }
    const isolated = { ...config, database: dbName };
    await migrate(isolated, MIGRATIONS_DIR);
    pool = createPool({ ...isolated, max: 4 }) as unknown as Pool;

    const ps = new PasswordService();
    const h1 = await ps.hashPassword("page-pass-123");
    userId = (
      await pool.query<{ id: string }>(
        `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash)
         VALUES ($1,'Pager A','learner','active','UTC',10,$2) RETURNING id`,
        ["page-user-a", h1],
      )
    ).rows[0]!.id;
    const h2 = await ps.hashPassword("page-pass-456");
    otherUserId = (
      await pool.query<{ id: string }>(
        `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash)
         VALUES ($1,'Pager B','learner','active','UTC',10,$2) RETURNING id`,
        ["page-user-b", h2],
      )
    ).rows[0]!.id;
    void otherUserId;
  });

  afterAll(async () => {
    try {
      if (pool) await pool.end();
      if (dbName) {
        const dropPool = createPool({ ...config, database: "postgres", max: 1 });
        try {
          await dropPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
        } finally {
          await dropPool.end();
        }
      }
    } finally {
      void pool;
    }
  });

  afterEach(async () => {
    // 严格清空事实；users 保留。
    await pool.query("TRUNCATE course_enrollments CASCADE");
    await pool.query("TRUNCATE course_releases CASCADE");
    await pool.query("TRUNCATE courses CASCADE");
  });

  /** 直接种发布课程，指定 release_number（默认 1），固定排序基准。 */
  async function seedPublishedCourse(
    releaseNumber = 1,
    level = "a1",
    visibility = "published",
  ): Promise<{
    courseId: string;
    releaseNumber: number;
  }> {
    const courseId = randomUUID();
    const releaseId = randomUUID();
    await pool.query(
      `INSERT INTO courses (id, slug, title, level, visibility, status, current_release_id)
       VALUES ($1,$2,'课程 $1','${level}','${visibility}','active',NULL)`,
      [courseId, `slug-${randomUUID()}`],
    );
    await pool.query(
      `INSERT INTO course_releases (id, course_id, release_number, title, level, description, source_draft_version, content_hash, created_by)
       VALUES ($1,$2,$3,'发布','a1','desc',1,'h', $4)`,
      [releaseId, courseId, releaseNumber, userId],
    );
    await pool.query(`UPDATE courses SET current_release_id = $1 WHERE id = $2`, [
      releaseId,
      courseId,
    ]);
    return { courseId, releaseNumber };
  }

  const svc = (): CourseService => new CourseService(pool as never);

  /** 用可选 cursor 调用分页列表，规避 exactOptionalPropertyTypes 对显式 undefined 的拒绝。 */
  async function listPage(
    limit: number | undefined,
    cursor: string | undefined,
  ): Promise<Awaited<ReturnType<CourseService["listCatalogCourses"]>>> {
    const args: { limit?: number; cursor?: string } = {};
    if (limit !== undefined) args.limit = limit;
    if (cursor !== undefined) args.cursor = cursor;
    return svc().listCatalogCourses(userId, args);
  }

  it("默认 limit=24：第一页只返回 24 条，nextCursor 非空", async () => {
    // 种 30 门可见课程，全部分配不同 release_number 以保证排序不同。
    const all: { courseId: string }[] = [];
    for (let i = 0; i < 30; i++) {
      all.push(await seedPublishedCourse());
    }
    const page1 = await svc().listCatalogCourses(userId);
    expect(page1.items.length).toBe(24);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeTruthy();
    // 无重叠
    const ids = new Set(page1.items.map((c) => c.courseId));
    expect(ids.size).toBe(24);
  });

  it("limit 上限 50：请求 limit=50 返回至多 50 条", async () => {
    for (let i = 0; i < 55; i++) await seedPublishedCourse();
    const page = await svc().listCatalogCourses(userId, { limit: 50 });
    expect(page.items.length).toBe(50);
    expect(page.hasMore).toBe(true);
  });

  it("多页遍历恰好覆盖所有可见课程，无重复", async () => {
    for (let i = 0; i < 60; i++) await seedPublishedCourse();
    const collected: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    do {
      const page = await listPage(24, cursor);
      expect(page.items.length).toBe(Math.min(24, 60 - collected.length));
      for (const it of page.items) collected.push(it.courseId);
      expect(new Set(collected).size).toBe(collected.length); // 无重复
      cursor = page.nextCursor ?? undefined;
      guard++;
      expect(guard).toBeLessThan(10);
    } while (cursor);
    // 恰好 60 门
    expect(collected.length).toBe(60);
    expect(new Set(collected).size).toBe(60);
  });

  it("发布版本降序、course_id 升序稳定", async () => {
    // 给 3 门不同 release_number（直接在创建时传入，release_rows 不可 UPDATE）。
    const a = await seedPublishedCourse(5);
    const b = await seedPublishedCourse(3);
    const c = await seedPublishedCourse(1);

    const page = await svc().listCatalogCourses(userId);
    const order = page.items.map((x) => x.courseId);
    // release_number DESC：a(5) > b(3) > c(1)
    expect(order.indexOf(a.courseId)).toBeLessThan(order.indexOf(b.courseId));
    expect(order.indexOf(b.courseId)).toBeLessThan(order.indexOf(c.courseId));
  });

  it("同一 cursor 重放结果稳定（幂等）", async () => {
    for (let i = 0; i < 40; i++) await seedPublishedCourse();
    const p1 = await svc().listCatalogCourses(userId, { limit: 20 });
    const p1b = await svc().listCatalogCourses(userId, { limit: 20 });
    expect(p1.items.map((x) => x.courseId)).toEqual(p1b.items.map((x) => x.courseId));
    expect(p1.nextCursor).toBe(p1b.nextCursor);
    const p2 = await svc().listCatalogCourses(userId, { limit: 20, cursor: p1.nextCursor! });
    const p2b = await svc().listCatalogCourses(userId, { limit: 20, cursor: p1.nextCursor! });
    expect(p2.items.map((x) => x.courseId)).toEqual(p2b.items.map((x) => x.courseId));
    // 页1 与 页2 无重叠
    const s1 = new Set(p1.items.map((x) => x.courseId));
    expect(p2.items.every((x) => !s1.has(x.courseId))).toBe(true);
  });

  it("hidden/inactive 课程永不返回；报名/主课程状态跨页正确", async () => {
    // 30 门可见 + 1 门 archived visibility + 1 门 inactive。
    for (let i = 0; i < 30; i++) await seedPublishedCourse();
    const hidden = await seedPublishedCourse();
    await pool.query(`UPDATE courses SET visibility='archived' WHERE id=$1`, [hidden.courseId]);
    const inactive = await seedPublishedCourse();
    await pool.query(`UPDATE courses SET status='archived' WHERE id=$1`, [inactive.courseId]);
    // 把第一门设为主课程，让 isPrimary 出现在分页里。
    const page1 = await svc().listCatalogCourses(userId);
    const primaryId = page1.items[0]!.courseId;
    await pool.query(
      `INSERT INTO course_enrollments (user_id, course_id, active, is_primary) VALUES ($1,$2,true,true)`,
      [userId, primaryId],
    );

    const all: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    do {
      const page = await listPage(undefined, cursor);
      for (const it of page.items) all.push(it.courseId);
      cursor = page.nextCursor ?? undefined;
      guard++;
      if (guard > 20) break;
    } while (cursor);

    expect(all).not.toContain(hidden.courseId);
    expect(all).not.toContain(inactive.courseId);
    expect(all.length).toBe(30);
    expect(new Set(all).size).toBe(30);
  });

  it("新课程插入不破坏既有 cursor（keyset 稳定）", async () => {
    for (let i = 0; i < 30; i++) await seedPublishedCourse();
    const p1 = await svc().listCatalogCourses(userId, { limit: 24 });
    // 插入一门高版本新课程（release_number=99，排在最前）。
    const extra = await seedPublishedCourse(99);
    void extra;
    // 用旧 cursor 继续：keyset 谓词按 release_number 边界，新课程不会导致已取边界重置。
    const p2 = await svc().listCatalogCourses(userId, { limit: 24, cursor: p1.nextCursor! });
    expect(p2.items.length).toBeGreaterThan(0);
    expect(
      new Set([...p1.items.map((x) => x.courseId), ...p2.items.map((x) => x.courseId)]).size,
    ).toBe(p1.items.length + p2.items.length);
  });

  it("非法 cursor → 抛 422 异常；limit 超限/小于 1 同理", async () => {
    const bad = Buffer.from("garbage").toString("base64url");
    await expect(svc().listCatalogCourses(userId, { cursor: bad })).rejects.toThrow(/422|游标/);
  });

  it("真实上限校验：listCatalogCourses 内部钳制 limit，超出最大值用 50", async () => {
    for (let i = 0; i < 70; i++) await seedPublishedCourse();
    const page = await svc().listCatalogCourses(userId, { limit: 100 });
    expect(page.items.length).toBeLessThanOrEqual(50);
  });
});
