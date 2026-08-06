// 认证用例：登录、改密、登出、会话管理；管理员建号/停用/重置（幂等 + 审计）。
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { validateNewPassword } from "@motro/domain";
import { PasswordService } from "./password.service.js";
import { SessionService, type SessionSummary, type UserRecord } from "./session.service.js";
import { POOL, type Pool } from "./database.provider.js";

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  role: "learner" | "admin";
  timezone: string;
  dailyBudgetMinutes: number;
  mustChangePassword: boolean;
}

function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    timezone: user.timezone,
    dailyBudgetMinutes: user.daily_budget_minutes,
    mustChangePassword: user.must_change_password,
  };
}

export interface LoginResult {
  user: PublicUser;
  sessionToken: string;
}

export interface AdminCreateResult {
  user: PublicUser;
  oneTimePassword: string;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    private readonly passwordService: PasswordService,
    private readonly sessionService: SessionService,
  ) {}

  private async findUserByUsername(username: string): Promise<UserRecord | undefined> {
    const result = await this.pool.query<UserRecord>(
      `SELECT id, username, display_name, role, status, timezone, daily_budget_minutes, password_hash, password_version, must_change_password, otp_consumed, created_at, updated_at
       FROM users WHERE username = $1`,
      [username.trim().toLowerCase()],
    );
    return result.rows[0];
  }

  /** 登录：未知用户与错误密码返回同一公开错误，不泄露账号是否存在。 */
  async login(username: string, password: string): Promise<LoginResult> {
    const user = await this.findUserByUsername(username);
    const ok =
      user !== undefined &&
      (await this.passwordService.verifyPassword(user.password_hash, password));
    if (!user || !ok || user.status !== "active") {
      throw new UnauthorizedException("用户名或密码错误");
    }

    // 一次性密码消费：must_change_password 用户成功登录后，该 OTP 立即失效。
    // 使用条件 UPDATE 原子认领：并发请求最多只有一个能置位，其余得到 401。
    if (user.must_change_password) {
      const claim = await this.pool.query(
        `UPDATE users SET otp_consumed = true WHERE id = $1 AND must_change_password = true AND otp_consumed = false`,
        [user.id],
      );
      if (claim.rowCount === 0) throw new UnauthorizedException("用户名或密码错误");
      user.otp_consumed = true;
    }

    const session = await this.sessionService.createSession(user.id, {
      loginAt: new Date().toISOString(),
    });
    return { user: toPublicUser(user), sessionToken: session.token };
  }

  async me(userId: string): Promise<PublicUser> {
    const result = await this.pool.query<UserRecord>(
      `SELECT id, username, display_name, role, status, timezone, daily_budget_minutes, password_hash, password_version, must_change_password, otp_consumed, created_at, updated_at FROM users WHERE id = $1`,
      [userId],
    );
    const user = result.rows[0];
    if (!user) throw new UnauthorizedException("会话无效或已过期");
    return toPublicUser(user);
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    keepSessionId: string,
  ): Promise<void> {
    const user = await this.getUser(userId);
    const ok = await this.passwordService.verifyPassword(user.password_hash, currentPassword);
    if (!ok) throw new UnauthorizedException("当前密码错误");

    const errors = validateNewPassword(newPassword);
    if (errors.length > 0)
      throw new ConflictException({
        message: "新密码不符合要求",
        fieldErrors: errors.map((message) => ({ path: "newPassword", code: "invalid", message })),
      });

    const nextHash = await this.passwordService.hashPassword(newPassword);
    const nextVersion = user.password_version + 1;
    await this.pool.query(
      `UPDATE users SET password_hash = $2, password_version = $3, must_change_password = false, otp_consumed = false, updated_at = now() WHERE id = $1`,
      [userId, nextHash, nextVersion],
    );
    // 修改密码后撤销其他会话，保留当前会话。
    await this.sessionService.revokeOtherSessions(userId, keepSessionId);
    await this.audit(userId, "auth.change_password", "user", userId, undefined, {
      passwordVersion: nextVersion,
    });
  }

  async logout(sessionId: string, userId: string): Promise<void> {
    await this.sessionService.revokeSession(sessionId, userId);
  }

  async listOwnSessions(userId: string): Promise<SessionSummary[]> {
    const sessions = await this.sessionService.listSessions(userId);
    return sessions.map((s) => ({
      id: s.id,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      idleExpiresAt: s.idle_expires_at,
      absoluteExpiresAt: s.absolute_expires_at,
      revokedAt: s.revoked_at,
    }));
  }

  async revokeOwnSession(userId: string, sessionId: string): Promise<void> {
    await this.sessionService.revokeSession(sessionId, userId);
  }

  /** 管理员：创建账号（一次性密码，仅返回一次）。幂等 + 审计。 */
  async createUser(
    actor: UserRecord,
    input: {
      username: string;
      displayName: string;
      timezone: string;
      dailyBudgetMinutes: number;
      role: "learner" | "admin";
    },
    requestId: string,
  ): Promise<AdminCreateResult> {
    const oneTimePassword = randomBytes(12).toString("base64url");
    const hashValue = await this.passwordService.hashPassword(oneTimePassword);
    const username = input.username.trim().toLowerCase();
    if (!/^[a-z0-9_.-]{3,32}$/.test(username)) {
      throw new ConflictException({
        message: "用户名不合法",
        fieldErrors: [
          { path: "username", code: "invalid", message: "用户名需为 3-32 位小写字母/数字/._-" },
        ],
      });
    }

    try {
      const result = await this.pool.query<UserRecord>(
        `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
         VALUES ($1, $2, $3, 'active', $4, $5, $6, true)
         ON CONFLICT (username) DO NOTHING
         RETURNING id, username, display_name, role, status, timezone, daily_budget_minutes, password_hash, password_version, must_change_password, otp_consumed, created_at, updated_at`,
        [
          username,
          input.displayName,
          input.role,
          input.timezone,
          input.dailyBudgetMinutes,
          hashValue,
        ],
      );
      const user = result.rows[0];
      if (!user) throw new ConflictException("用户名已存在");

      await this.audit(
        actor.id,
        "admin.user.create",
        "user",
        user.id,
        undefined,
        { username },
        requestId,
      );
      return { user: toPublicUser(user), oneTimePassword };
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      throw err;
    }
  }

  /** 管理员：停用账号并撤销全部会话。审计。 */
  async disableUser(actor: UserRecord, userId: string, requestId: string): Promise<void> {
    const result = await this.pool.query<UserRecord>(
      `UPDATE users SET status = 'disabled', updated_at = now() WHERE id = $1 AND status = 'active' RETURNING id, username`,
      [userId],
    );
    if (result.rowCount === 0) throw new NotFoundException("用户不存在或已停用");
    await this.sessionService.revokeAll(userId);
    await this.audit(
      actor.id,
      "admin.user.disable",
      "user",
      userId,
      undefined,
      { username: result.rows[0]?.username },
      requestId,
    );
  }

  /** 管理员：重置一次性密码并撤销全部会话。幂等。 */
  async resetPassword(
    actor: UserRecord,
    userId: string,
    requestId: string,
  ): Promise<AdminCreateResult> {
    const user = await this.getUser(userId);
    const oneTimePassword = randomBytes(12).toString("base64url");
    const hashValue = await this.passwordService.hashPassword(oneTimePassword);
    await this.pool.query(
      `UPDATE users SET password_hash = $2, must_change_password = true, otp_consumed = false, password_version = password_version + 1, updated_at = now() WHERE id = $1`,
      [userId, hashValue],
    );
    await this.sessionService.revokeAll(userId);
    await this.audit(
      actor.id,
      "admin.user.reset_password",
      "user",
      userId,
      undefined,
      { username: user.username },
      requestId,
    );
    return {
      user: toPublicUser({ ...user, password_hash: hashValue, must_change_password: true }),
      oneTimePassword,
    };
  }

  async listUsers(): Promise<PublicUser[]> {
    const result = await this.pool.query<UserRecord>(
      `SELECT id, username, display_name, role, status, timezone, daily_budget_minutes, password_hash, password_version, must_change_password, otp_consumed, created_at, updated_at
       FROM users ORDER BY created_at ASC LIMIT 100`,
    );
    return result.rows.map(toPublicUser);
  }

  async getUserPublic(userId: string): Promise<PublicUser> {
    return toPublicUser(await this.getUser(userId));
  }

  // ---- 幂等 ----
  private async claimIdempotency(
    scope: string,
    key: string,
    requestHash: string,
  ): Promise<unknown | "claimed"> {
    const claim = await this.pool.query<{ response_json: unknown; request_hash: string }>(
      `INSERT INTO idempotency_keys (scope, key, request_hash, response_json) VALUES ($1, $2, $3, $4)
       ON CONFLICT (scope, key) DO NOTHING RETURNING response_json, request_hash`,
      [scope, key, requestHash, JSON.stringify({ pending: true })],
    );
    if (claim.rowCount === 0) {
      const existing = await this.pool.query<{ response_json: unknown; request_hash: string }>(
        `SELECT response_json, request_hash FROM idempotency_keys WHERE scope = $1 AND key = $2`,
        [scope, key],
      );
      const row = existing.rows[0];
      if (!row) return null;
      if (row.request_hash !== requestHash) {
        throw new ConflictException("IDEMPOTENCY_CONFLICT：该请求键已用于不同的请求内容");
      }
      return row.response_json;
    }
    return "claimed";
  }

  private requestHashOf(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }

  private async completeIdempotency(scope: string, key: string, response: unknown): Promise<void> {
    await this.pool.query(
      `UPDATE idempotency_keys SET response_json = $3 WHERE scope = $1 AND key = $2`,
      [scope, key, JSON.stringify(response)],
    );
  }

  private async releaseIdempotency(scope: string, key: string): Promise<void> {
    await this.pool.query(`DELETE FROM idempotency_keys WHERE scope = $1 AND key = $2`, [
      scope,
      key,
    ]);
  }

  async createUserIdempotent(
    actor: UserRecord,
    input: Parameters<AuthService["createUser"]>[1],
    requestId: string,
    idempotencyKey?: string,
  ): Promise<AdminCreateResult> {
    if (!idempotencyKey) throw new BadRequestException("缺少 Idempotency-Key 头");
    const scope = `admin:create-user:${actor.id}`;
    const claimed = await this.claimIdempotency(scope, idempotencyKey, this.requestHashOf(input));
    if (claimed !== "claimed") return claimed as AdminCreateResult;
    try {
      const result = await this.createUser(actor, input, requestId);
      await this.completeIdempotency(scope, idempotencyKey, result);
      return result;
    } catch (err) {
      await this.releaseIdempotency(scope, idempotencyKey);
      throw err;
    }
  }

  async resetPasswordIdempotent(
    actor: UserRecord,
    userId: string,
    requestId: string,
    idempotencyKey?: string,
  ): Promise<AdminCreateResult> {
    if (!idempotencyKey) throw new BadRequestException("缺少 Idempotency-Key 头");
    const scope = `admin:reset-password:${actor.id}:${userId}`;
    const claimed = await this.claimIdempotency(
      scope,
      idempotencyKey,
      this.requestHashOf({ userId }),
    );
    if (claimed !== "claimed") return claimed as AdminCreateResult;
    try {
      const result = await this.resetPassword(actor, userId, requestId);
      await this.completeIdempotency(scope, idempotencyKey, result);
      return result;
    } catch (err) {
      await this.releaseIdempotency(scope, idempotencyKey);
      throw err;
    }
  }

  // ---- 内部 ----
  private async getUser(userId: string): Promise<UserRecord> {
    const result = await this.pool.query<UserRecord>(
      `SELECT id, username, display_name, role, status, timezone, daily_budget_minutes, password_hash, password_version, must_change_password, otp_consumed, created_at, updated_at FROM users WHERE id = $1`,
      [userId],
    );
    const user = result.rows[0];
    if (!user) throw new NotFoundException("用户不存在");
    return user;
  }

  private async audit(
    actorId: string | null,
    action: string,
    targetType: string,
    targetId: string,
    before?: unknown,
    after?: unknown,
    requestId?: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_events (actor_id, action, target_type, target_id, before_summary, after_summary, request_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
      [
        actorId,
        action,
        targetType,
        targetId,
        before === undefined ? null : JSON.stringify(before),
        after === undefined ? null : JSON.stringify(after),
        requestId ?? null,
      ],
    );
  }
}
