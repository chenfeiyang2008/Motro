// admin-imports E2E 清理助手（P1-3 / P1-4）。
//
// 策略：本 E2E 运行在【独立数据库】（compose/e2e-import.yml 的 motro_e2e_import），因此清理分两层：
//   1) cleanupIsolatedAdmin：在【正常 FK/trigger 全部启用】下，删除本运行可安全删除的资源
//      （auth_sessions / idempotency / audit / 可删 batch / file / source）。
//      绝不用 session_replication_role，绝不用 ALTER TABLE ... DISABLE TRIGGER。
//   2) 不可变 commit facts（import_batch_commits / import_batch_commit_rows）与 lexical entries：
//      由 runbook 的 `docker compose -f compose/e2e-import.yml down -v` 整体销毁独立库处理。
//      删除这些在共享库上本就被产品规则禁止；独立库整体销毁是唯一不绕过约束的清理路径。
//
// 关键安全规则（P1-2 / P1-3）：
//   - 绝不以「source 的 created_by」反推 lexical entry 一定属于测试 → 本清理【不删除任何
//     lexical_entries】。词条（含隔离用户自己创建的）一律留给独立库整体销毁。
//     这样即使测试只关联了外部词条（为该词条建了 import source），也不会误删外部词条。
//   - 只删除本运行明确创建的 source / file / batch（无 commit 的）、idempotency、audit、session、用户。
import { createPool, loadDbConfigFromEnv } from "@motro/db";
import { assertSafeDbName } from "./import-e2e-db.js";

export interface ImportTestAdmin {
  userId: string;
  username: string;
}

/** 隔离 E2E 数据库端口（runbook 设置；默认回退环境 POSTGRES_PORT）。 */
function dbPort(): number {
  return Number(process.env.E2E_POSTGRES_PORT ?? process.env.POSTGRES_PORT ?? 5432);
}

/** 隔离 E2E 数据库名（runbook 必须设置；安全白名单拒绝共享库名）。 */
function dbName(): string {
  const name = process.env.E2E_IMPORT_DB ?? "";
  assertSafeDbName(name);
  return name;
}

/**
 * 在正常约束下删除本运行可安全删除的资源。
 * 若删除遇到意外失败，抛错使 E2E 失败（不吞异常）。
 * 词条与不可变 commit facts 保留给独立库整体销毁（runbook down -v）。
 */
export async function cleanupIsolatedAdmin(admin: ImportTestAdmin): Promise<void> {
  const pool = createPool({ ...loadDbConfigFromEnv(), database: dbName(), port: dbPort() });
  const { userId } = admin;
  try {
    await pool.query("BEGIN");
    // 1) 该隔离用户的会话（正常 FK 下删除；auth_sessions.user_id 有 ON DELETE CASCADE）。
    await pool.query(`DELETE FROM auth_sessions WHERE user_id = $1::uuid`, [userId]);
    // 2) 可删的 batch / file：仅删「没有 commit 的 batch」及其 file（有 commit 的保留给库销毁）。
    //    先删 batch（其 file FK 指向 stored_files），再删 file，遵守 FK 顺序。
    await pool.query(
      `DELETE FROM import_batches
       WHERE uploaded_by = $1::uuid
         AND NOT EXISTS (SELECT 1 FROM import_batch_commits c WHERE c.batch_id = import_batches.id)`,
      [userId],
    );
    await pool.query(
      `DELETE FROM stored_files
       WHERE id NOT IN (SELECT file_id FROM import_batches)
         AND uploaded_by = $1::uuid`,
      [userId],
    );
    // 3) 本运行创建的 lexical sources：仅删未被任何 commit row 引用的（其余留给库销毁）。
    //    绝不删除 lexical_entries（见顶部安全规则）。
    await pool.query(
      `DELETE FROM lexical_sources
       WHERE created_by = $1::uuid
         AND NOT EXISTS (SELECT 1 FROM import_batch_commit_rows cr WHERE cr.lexical_source_id = lexical_sources.id)`,
      [userId],
    );
    // 4) 幂等 / 审计。
    const scopes = [
      `import:batch:create:${userId}`,
      `import:validate:${userId}`,
      `import:commit:${userId}`,
    ];
    await pool.query(`DELETE FROM idempotency_keys WHERE scope = ANY($1::text[])`, [scopes]);
    await pool.query(`DELETE FROM audit_events WHERE actor_id = $1::uuid`, [userId]);
    // 5) 删除用户：若仍有不可变 commit facts 引用（committed_by RESTRICT），保留并留给库销毁。
    const delUser = await pool.query(
      `DELETE FROM users WHERE id = $1::uuid
       AND NOT EXISTS (SELECT 1 FROM import_batch_commits c WHERE c.committed_by = $1::uuid)`,
      [userId],
    );
    await pool.query("COMMIT");
    if (delUser.rowCount === 0) {
      // 明确的「预期保留」：用户被不可变 commit facts 引用，独立库整体销毁时一并清除。
      console.warn(
        `[admin-imports] 隔离用户 ${admin.username} 因不可变 commit facts 引用而保留；` +
          `由独立库销毁（down -v）负责清理。`,
      );
    }
  } catch (e) {
    await pool.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await pool.end();
  }
}
