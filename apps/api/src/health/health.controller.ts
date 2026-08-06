// liveness/readiness：均无需认证，返回结构化、无 secret 的结果。
import { Controller, Get, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { DbHealthService } from "./db-health.service.js";

interface HealthOk {
  status: "ok" | "degraded";
  service: string;
  time: string;
}

interface HealthResponse extends HealthOk {
  checks?: { db: "ok" | "down" };
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
    const dbOk = await this.dbHealth.check();
    const body: HealthResponse = {
      status: dbOk ? "ok" : "degraded",
      service: "motro-api",
      time: new Date().toISOString(),
      checks: { db: dbOk ? "ok" : "down" },
    };
    if (!dbOk) reply.status(503);
    return body;
  }
}
