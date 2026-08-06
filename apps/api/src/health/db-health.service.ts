// readiness 检查数据库连通性；不读取任何业务数据。
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

  async check(): Promise<boolean> {
    try {
      await this.getPool().query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }
}
