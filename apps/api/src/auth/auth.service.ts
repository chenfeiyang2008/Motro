// 认证用例：登录、改密、登出、会话管理；管理员建号/停用/重置（幂等 + 审计）。
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
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
  /** 账号状态：active | disabled（来自 users.status）。 */
  status: "active" | "disabled";
  /** 账号创建时间 ISO 字符串。 */
  createdAt: string;
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
    status: user.status,
    createdAt: toIso(user.created_at),
  };
}

function toIso(d: Date): string {
  return new Date(d).toISOString();
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
    if (actor.id === userId) {
      throw new ConflictException("不能停用自己的账号");
    }
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

  /** 管理员：删除没有业务事实关联的账号；有历史数据时必须停用而非级联抹除。 */
  async deleteUser(actor: UserRecord, userId: string, requestId: string): Promise<void> {
    if (actor.id === userId) {
      throw new ConflictException("不能删除自己的账号");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query<UserRecord>(
        `SELECT id, username, display_name, role, status, timezone, daily_budget_minutes,
                password_hash, password_version, must_change_password, otp_consumed,
                created_at, updated_at
         FROM users WHERE id = $1 FOR UPDATE`,
        [userId],
      );
      const user = found.rows[0];
      if (!user) throw new NotFoundException("用户不存在");

      // 不依赖各表的 ON DELETE 行为：即使某张学习表配置了 CASCADE，
      // 只要已有任何外键事实，就禁止物理删除，避免抹掉学习历史。
      const references = await client.query<{
        schema_name: string;
        table_name: string;
        column_name: string;
      }>(
        `SELECT ns.nspname AS schema_name, cls.relname AS table_name, att.attname AS column_name
         FROM pg_constraint con
         JOIN pg_class cls ON cls.oid = con.conrelid
         JOIN pg_namespace ns ON ns.oid = cls.relnamespace
         JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
         WHERE con.contype = 'f'
           AND con.confrelid = 'public.users'::regclass
           AND array_length(con.conkey, 1) = 1
           AND ns.nspname NOT IN ('pg_catalog', 'information_schema')`,
      );
      const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
      for (const reference of references.rows) {
        const dependency = await client.query(
          `SELECT 1 FROM ${quoteIdentifier(reference.schema_name)}.${quoteIdentifier(reference.table_name)}
           WHERE ${quoteIdentifier(reference.column_name)} = $1 LIMIT 1`,
          [userId],
        );
        if ((dependency.rowCount ?? 0) > 0) {
          throw new ConflictException("该账号已有业务或审计数据，不能物理删除，请改用停用");
        }
      }

      try {
        await client.query("DELETE FROM users WHERE id = $1", [userId]);
      } catch (err) {
        // PostgreSQL 23503 means a learning, audit, membership or other business
        // fact still references this account. Never cascade-delete those facts.
        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code?: unknown }).code === "23503"
        ) {
          throw new ConflictException("该账号已有业务或审计数据，不能物理删除，请改用停用");
        }
        throw err;
      }

      await client.query(
        `INSERT INTO audit_events (actor_id, action, target_type, target_id, before_summary, request_id)
         VALUES ($1, 'admin.user.delete', 'user', $2, $3::jsonb, $4)`,
        [actor.id, userId, JSON.stringify({ user: toPublicUser(user) }), requestId],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
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

  /** 管理员：列出账号，支持 q/role/status 过滤 + keyset 分页。 */
  async listUsers(opts: {
    q?: string;
    role?: "learner" | "admin";
    status?: "active" | "disabled";
    cursor?: string;
    limit?: number;
  }): Promise<{ items: PublicUser[]; nextCursor: string | null; hasMore: boolean }> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const params: unknown[] = [];
    const where: string[] = [];

    const q = (opts.q ?? "").trim();
    if (q.length > 0) {
      const escaped = q.replace(/[\\%_]/g, (m) => `\\${m}`);
      params.push(`%${escaped}%`);
      const idx = params.length;
      where.push(`(username ILIKE $${idx} ESCAPE '\\' OR display_name ILIKE $${idx} ESCAPE '\\')`);
    }
    if (opts.role) {
      params.push(opts.role);
      where.push(`role = $${params.length}`);
    }
    if (opts.status) {
      params.push(opts.status);
      where.push(`status = $${params.length}`);
    }
    if (opts.cursor) {
      const key = decodeUserCursor(opts.cursor);
      params.push(key.createdAt, key.id);
      const last = params.length;
      where.push(`(created_at, id) > ($${last - 1}, $${last})`);
    }

    params.push(limit + 1);
    const sql = `
      SELECT id, username, display_name, role, status, timezone, daily_budget_minutes,
             password_hash, password_version, must_change_password, otp_consumed, created_at, updated_at
      FROM users
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at ASC, id ASC
      LIMIT $${params.length}
    `;
    const result = await this.pool.query<UserRecord>(sql, params);
    const rows = result.rows;
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      items: pageRows.map(toPublicUser),
      nextCursor:
        hasMore && last
          ? encodeUserCursor({ createdAt: new Date(last.created_at).toISOString(), id: last.id })
          : null,
      hasMore,
    };
  }

  /** 管理员：编辑允许的账号字段（白名单 DTO）。审计 + 幂等。 */
  async updateUser(
    actor: UserRecord,
    userId: string,
    patch: {
      displayName?: string;
      role?: "learner" | "admin";
      timezone?: string;
      dailyBudgetMinutes?: number;
      mustChangePassword?: boolean;
    },
    requestId: string,
    idempotencyKey?: string,
  ): Promise<PublicUser> {
    if (!idempotencyKey) throw new BadRequestException("缺少 Idempotency-Key 头");
    const scope = `admin:update-user:${actor.id}:${userId}`;
    const requestHash = createHash("sha256").update(JSON.stringify(patch)).digest("hex");
    const claimed = await this.claimIdempotency(scope, idempotencyKey, requestHash);
    if (claimed !== "claimed") return claimed as PublicUser;

    const user = await this.getUser(userId);
    const before = { ...toPublicUser(user) };
    // 管理者不能把自己改成非管理员（防止最后一个管理员自我降权）。
    if (userId === actor.id && patch.role === "learner" && user.role === "admin") {
      throw new ConflictException("不能把自己的角色降为学习者");
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const next = { ...user };
    if (patch.displayName !== undefined) {
      params.push(patch.displayName.trim());
      sets.push(`display_name = $${params.length}`);
      next.display_name = patch.displayName.trim();
    }
    if (patch.role !== undefined) {
      params.push(patch.role);
      sets.push(`role = $${params.length}`);
      next.role = patch.role;
    }
    if (patch.timezone !== undefined) {
      params.push(patch.timezone.trim());
      sets.push(`timezone = $${params.length}`);
      next.timezone = patch.timezone.trim();
    }
    if (patch.dailyBudgetMinutes !== undefined) {
      params.push(patch.dailyBudgetMinutes);
      sets.push(`daily_budget_minutes = $${params.length}`);
      next.daily_budget_minutes = patch.dailyBudgetMinutes;
    }
    if (patch.mustChangePassword !== undefined) {
      params.push(patch.mustChangePassword);
      sets.push(`must_change_password = $${params.length}`);
      next.must_change_password = patch.mustChangePassword;
    }
    if (sets.length === 0) {
      throw new UnprocessableEntityException({ message: "没有可更新的字段", fieldErrors: [] });
    }
    params.push(userId);
    sets.push(`updated_at = now()`);
    const result = await this.pool.query<UserRecord>(
      `UPDATE users SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING id, username, display_name, role, status, timezone, daily_budget_minutes, password_hash, password_version, must_change_password, otp_consumed, created_at, updated_at`,
      params,
    );
    const updated = result.rows[0];
    if (!updated) throw new NotFoundException("用户不存在");
    await this.audit(
      actor.id,
      "admin.user.update",
      "user",
      userId,
      { before: stripPublic(before) },
      { after: stripPublic(toPublicUser(updated)) },
      requestId,
    );
    await this.completeIdempotency(scope, idempotencyKey, toPublicUser(updated));
    return toPublicUser(updated);
  }

  /** 管理员：重新启用已停用账号。审计。 */
  async enableUser(actor: UserRecord, userId: string, requestId: string): Promise<PublicUser> {
    const result = await this.pool.query<UserRecord>(
      `UPDATE users SET status = 'active', updated_at = now() WHERE id = $1 AND status = 'disabled' RETURNING id, username, display_name, role, status, timezone, daily_budget_minutes, password_hash, password_version, must_change_password, otp_consumed, created_at, updated_at`,
      [userId],
    );
    const user = result.rows[0];
    if (!user) throw new NotFoundException("用户不存在或未停用");
    await this.audit(
      actor.id,
      "admin.user.enable",
      "user",
      userId,
      undefined,
      { username: user.username },
      requestId,
    );
    return toPublicUser(user);
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

// ---- 用户分页游标 ----

function encodeUserCursor(key: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

function decodeUserCursor(cursor: string): { createdAt: string; id: string } {
  let parsed: { createdAt?: string; id?: string };
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      createdAt?: string;
      id?: string;
    };
  } catch {
    throw new UnprocessableEntityException({ message: "游标无效" });
  }
  if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") {
    throw new UnprocessableEntityException({ message: "游标缺少必需字段" });
  }
  return { createdAt: parsed.createdAt, id: parsed.id };
}

/** 返回 PublicUser 的纯数据副本（不含密码/token/OTP），用于审计 before/after。 */
function stripPublic(u: PublicUser): Record<string, unknown> {
  return { ...u };
}
