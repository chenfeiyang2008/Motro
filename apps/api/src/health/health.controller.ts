// liveness/readiness：均无需认证，返回结构化、无 secret 的结果。
// readiness 区分：
//   - DB 不可达：degraded / 503；
//   - DB 可达但 graphile_worker schema 不存在：degraded / 503（业务 migration 已完成
//     但 worker schema 未就绪）；
//   - 两者均就绪：ok / 200。
import { Controller, Get, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { DbHealthService } from "./db-health.service.js";

interface HealthOk {
  status: "ok" | "degraded";
  service: string;
  time: string;
}

interface HealthResponse extends HealthOk {
  checks?: { db: "ok" | "down"; graphileWorker: "ok" | "missing" | "unknown" };
}

@Controller("health")
export class HealthController {
  constructor(private readonly dbHealth: DbHealthService) {}

  @Get("live")
  live(): HealthOk {
    return { status: "ok", service: "motro-api", time: new Date().toISOString() };
  }

  @Get("ready")
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<HealthResponse> {
    const c = await this.dbHealth.check();
    const dbOk = c.db === "ok";
    const workerOk = c.graphileWorker === "ok";
    const ready = dbOk && workerOk;
    const body: HealthResponse = {
      status: ready ? "ok" : "degraded",
      service: "motro-api",
      time: new Date().toISOString(),
      checks: { db: c.db, graphileWorker: c.graphileWorker },
    };
    if (!ready) reply.status(503);
    return body;
  }
}
