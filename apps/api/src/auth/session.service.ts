// 会话生命周期：创建、校验、轮换/撤销、闲置与绝对过期。
import { Inject, Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { loadConfig, type AppConfig } from "@motro/config";
import { POOL, type Pool } from "./database.provider.js";

export interface UserRecord {
  id: string;
  username: string;
  display_name: string;
  role: "learner" | "admin";
  status: "active" | "disabled";
  timezone: string;
  daily_budget_minutes: number;
  password_hash: string;
  password_version: number;
  must_change_password: boolean;
  otp_consumed: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface SessionRecord {
  id: string;
  user_id: string;
  token_digest: string;
  created_at: Date;
  last_seen_at: Date;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
  client_summary: unknown;
}

export interface SessionSummary {
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
}

export interface ValidSession {
  session: SessionRecord;
  user: UserRecord;
}

@Injectable()
export class SessionService {
  private readonly config: AppConfig;

  constructor(@Inject(POOL) private readonly pool: Pool) {
    this.config = loadConfig();
  }

  generateToken(): string {
    return randomBytes(32).toString("base64url");
  }

  digest(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  async createSession(
    userId: string,
    clientSummary?: unknown,
  ): Promise<SessionRecord & { token: string }> {
    const token = this.generateToken();
    const now = new Date();
    const idleMs = this.config.cookie.idleMinutes * 60_000;
    const absoluteMs = this.config.cookie.absoluteHours * 3_600_000;
    const result = await this.pool.query<SessionRecord>(
      `INSERT INTO auth_sessions (user_id, token_digest, created_at, last_seen_at, idle_expires_at, absolute_expires_at, client_summary)
       VALUES ($1, $2, $3, $3, $4, $5, $6::jsonb)
       RETURNING id, user_id, token_digest, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at, client_summary`,
      [
        userId,
        this.digest(token),
        now,
        new Date(now.getTime() + idleMs),
        new Date(now.getTime() + absoluteMs),
        clientSummary === undefined ? null : JSON.stringify(clientSummary),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("创建会话失败");
    return { ...row, token }; // token 仅在此返回，入库的是摘要。
  }

  async validate(token: string): Promise<ValidSession | null> {
    const digest = this.digest(token);
    const result = await this.pool.query<SessionRecord>(
      `SELECT id, user_id, token_digest, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at, client_summary
       FROM auth_sessions WHERE token_digest = $1`,
      [digest],
    );
    const session = result.rows[0];
    if (!session) return null;

    const now = Date.now();
    if (session.revoked_at !== null) return null;
    if (new Date(session.absolute_expires_at).getTime() < now) return null;
    if (new Date(session.idle_expires_at).getTime() < now) return null;

    const userResult = await this.pool.query<UserRecord>(
      `SELECT id, username, display_name, role, status, timezone, daily_budget_minutes, password_hash, password_version, must_change_password, otp_consumed, created_at, updated_at
       FROM users WHERE id = $1`,
      [session.user_id],
    );
    const user = userResult.rows[0];
    if (!user || user.status !== "active") return null;

    // 滑动闲置过期：更新 last_seen_at 与 idle_expires_at。
    const idleMs = this.config.cookie.idleMinutes * 60_000;
    await this.pool.query(
      `UPDATE auth_sessions SET last_seen_at = $2, idle_expires_at = $3 WHERE id = $1`,
      [session.id, new Date(now), new Date(now + idleMs)],
    );

    return { session, user };
  }

  async revokeSession(id: string, userId: string): Promise<void> {
    await this.pool.query(
      `UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [id, userId],
    );
  }

  async revokeOtherSessions(userId: string, exceptId: string): Promise<void> {
    await this.pool.query(
      `UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
      [userId, exceptId],
    );
  }

  async revokeAll(userId: string): Promise<void> {
    await this.pool.query(
      `UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
  }

  async listSessions(userId: string): Promise<SessionRecord[]> {
    const result = await this.pool.query<SessionRecord>(
      `SELECT id, user_id, token_digest, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at, client_summary
       FROM auth_sessions WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return result.rows;
  }
}
