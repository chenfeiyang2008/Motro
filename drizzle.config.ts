// Drizzle Kit 配置：定位 schema、migration 输出目录与 PostgreSQL 连接。
// 生产部署的演进入口仍是 db/migrations 下的显式 SQL migration。
import { defineConfig } from "drizzle-kit";

const pg = {
  host: process.env.POSTGRES_HOST ?? "127.0.0.1",
  port: Number(process.env.POSTGRES_PORT ?? "5432"),
  database: process.env.POSTGRES_DB ?? "motro",
  user: process.env.POSTGRES_USER ?? "motro",
  password: process.env.POSTGRES_PASSWORD ?? "dev_only_change_me",
};

export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/db/src/schema/**/*.ts",
  out: "./db/migrations",
  dbCredentials: {
    url: `postgresql://${pg.user}:${pg.password}@${pg.host}:${pg.port}/${pg.database}`,
  },
});
