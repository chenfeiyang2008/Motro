// readiness 检查数据库连通性 + Graphile worker schema 就绪（工单 04 修复）：
//   - DB 不可达：degraded；
//   - DB 可达但 graphile_worker schema 不存在：degraded（区分「业务 migration 完成
//     但 worker schema 未就绪」）；
//   - 两者均就绪：ok。
// 不扫描 Graphile jobs 表，不读 `_private_*` 表，不泄露连接信息。
import { Injectable } from "@nestjs/common";
import { loadConfig, type AppConfig } from "@motro/config";
import { createPool } from "@motro/db";

@Injectable()
export class DbHealthService {
  private pool: ReturnType<typeof createPool> | undefined;
  private readonly config: AppConfig;

  constructor() {
    this.config = loadConfig();
  }

  private getPool(): ReturnType<typeof createPool> {
    this.pool ??= createPool({ ...this.config.db, max: 2 });
    return this.pool;
  }

  /** 关闭内部池（供测试/关闭钩子释放连接，避免阻塞隔离库 DROP）。 */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = undefined;
    }
  }

  /** 结构化检查结果：不抛异常，供 controller 决定 200/503。 */
  async check(): Promise<{
    db: "ok" | "down";
    graphileWorker: "ok" | "missing" | "unknown";
  }> {
    const result: { db: "ok" | "down"; graphileWorker: "ok" | "missing" | "unknown" } = {
      db: "down",
      graphileWorker: "unknown",
    };
    try {
      await this.getPool().query("SELECT 1");
      result.db = "ok";
    } catch {
      return result;
    }
    try {
      const r = await this.getPool().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.schemata WHERE schema_name = 'graphile_worker'`,
      );
      result.graphileWorker = Number(r.rows[0]?.n ?? 0) > 0 ? "ok" : "missing";
    } catch {
      result.graphileWorker = "unknown";
    }
    return result;
  }
}
