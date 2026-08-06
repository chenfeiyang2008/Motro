// CLI：从空库引导首位管理员。密码仅从环境变量读取，不写入任何文件/日志。
import { hash } from "@node-rs/argon2";
import { createPool, loadDbConfigFromEnv } from "./client.js";

async function main(): Promise<void> {
  const username = process.env.BOOTSTRAP_ADMIN_USERNAME ?? "admin";
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!password || password.length < 12) {
    console.error("请设置 BOOTSTRAP_ADMIN_PASSWORD（至少 12 字符）");
    process.exitCode = 1;
    return;
  }

  const pool = createPool(loadDbConfigFromEnv());
  try {
    const hashed = await hash(password, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });
    const result = await pool.query<{ id: string }>(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, '管理员', 'admin', 'active', 'Asia/Shanghai', 10, $2, false)
       ON CONFLICT (username) DO NOTHING RETURNING id`,
      [username, hashed],
    );
    if (result.rowCount === 0) {
      console.log(`管理员 ${username} 已存在，未改动`);
    } else {
      console.log(`已创建管理员 ${username}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(`bootstrap-admin 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
