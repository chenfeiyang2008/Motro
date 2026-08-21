// 集成测试共享的隔离 DB 生命周期助手。
//
// 目标：消除 `57P01 terminating connection due to administrator command` teardown 噪音。
//
// 根因：`apps/api` 各业务模块（Auth/Catalog/Study/Import/Operations）各自声明
// `databaseProvider`（原生 pg Pool，useFactory 无生命周期钩子）。Nest `app.close()`
// 不会自动 end 这些 pg Pool；`enableShutdownHooks()` 只响应操作系统信号。
// 若在 DROP DATABASE 前不显式 end 这些池，删除隔离库会强杀仍持活的空闲连接，
// 触发 pg Pool 未监听的 `error`（57P01）→ uncaught exception。
//
// 使用方负责人：
//   - tests/integration/catalog/catalog-read/catalog-read.spec.ts
//   - tests/integration/catalog/enrollment/enrollment.spec.ts
//   - （与 tests/integration/operations/worker-operations.spec.ts 同一模式）
//
// 生命周期约定（必须遵循）：
//   1. 停止新请求（测试体完成后）；
//   2. 显式 end 各模块池 + health 内部池 + 测试自建池；
//   3. 才 DROP 隔离数据库。
//   不依赖 pg_terminate_backend 满足旁路正常生命周期；清理失败不得吞异常、不得假通过。
import { createPool, loadDbConfigFromEnv } from "@motro/db";
import { createApp } from "../../../apps/api/src/bootstrap-app.js";
import { POOL, type Pool } from "../../../apps/api/src/auth/database.provider.js";
import { AuthModule } from "../../../apps/api/src/auth/auth.module.js";
import { CatalogModule } from "../../../apps/api/src/modules/catalog/catalog.module.js";
import { StudyModule } from "../../../apps/api/src/modules/study/study.module.js";
import { ImportModule } from "../../../apps/api/src/modules/admin/imports/import.module.js";
import { OperationsModule } from "../../../apps/api/src/modules/operations/operations.module.js";
import { GameModule } from "../../../apps/api/src/modules/game/game.module.js";
import { MotivationModule } from "../../../apps/api/src/modules/motivation/motivation.module.js";
import { MembershipModule } from "../../../apps/api/src/modules/membership/membership.module.js";
import { AdminModule } from "../../../apps/api/src/modules/admin/admin.module.js";
import { ReviewsModule } from "../../../apps/api/src/modules/reviews/reviews.module.js";
import { DbHealthService } from "../../../apps/api/src/health/db-health.service.js";

type App = Awaited<ReturnType<typeof createApp>>;

/**
 * 显式 end 应用内声明的所有 pg Pool（模块 Provider + health 内部池）+ 测试池。
 * 必须在 DROP 隔离数据库之前调用，避免用 pg_terminate_backend 强杀待释放连接（57P01）。
 */
export async function closeAppDbPools(app: App, extraPools: Pool[] = []): Promise<void> {
  const pools = new Set<Pool>();
  for (const module of [
    AuthModule,
    CatalogModule,
    StudyModule,
    ImportModule,
    OperationsModule,
    GameModule,
    MotivationModule,
    MembershipModule,
    AdminModule,
    ReviewsModule,
  ]) {
    try {
      pools.add(app.select(module).get<Pool>(POOL, { strict: true }));
    } catch {
      // 模块未装配 POOL（严格模式找不到）→ 跳过；不吞真实 DROP 失败。
    }
  }
  const health = app.get(DbHealthService);
  await health.close();
  for (const p of extraPools) pools.add(p);
  await Promise.all([...pools].map((p) => p.end()));
}

/**
 * 删除一个隔离数据库（幂等）。调用前必须已端掉所有指向该库的连接。
 * 使用 `POSTGRES_DB` 重写前捕获到的原始 config 连接 postgres 库执行 DROP。
 */
export async function dropIsolatedDatabase(dbName: string): Promise<void> {
  if (!dbName) return;
  const config = loadDbConfigFromEnv();
  const dropPool = createPool({ ...config, database: "postgres", max: 1 });
  try {
    await dropPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } finally {
    await dropPool.end();
  }
}
