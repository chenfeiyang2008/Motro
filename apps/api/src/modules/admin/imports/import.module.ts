// 管理导入模块（阶段 6 工单 01）：单批次上传、列表与详情。
// 启动（装配）时验证导入目录可写，失败即抛错，避免在不可写目录下静默降级。
import { Module } from "@nestjs/common";
import { loadConfig, type AppConfig } from "@motro/config";
import { mkdir, rm, access, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AuthModule } from "../../../auth/auth.module.js";
import { databaseProvider } from "../../../auth/database.provider.js";
import { OperationsModule } from "../../operations/operations.module.js";
import { ImportController } from "./import.controller.js";
import { ImportService } from "./import.service.js";
import { ImportParser } from "./import.parser.js";
import { ImportBatchRepository } from "./import.repository.js";
import { APP_CONFIG } from "./tokens.js";

@Module({
  imports: [AuthModule, OperationsModule],
  controllers: [ImportController],
  providers: [
    databaseProvider,
    ImportService,
    ImportParser,
    ImportBatchRepository,
    {
      provide: APP_CONFIG,
      useFactory: async (): Promise<AppConfig> => {
        const cfg = loadConfig();
        await assertImportDirWritable(cfg.import.fileRootDir);
        return cfg;
      },
    },
  ],
})
export class ImportModule {}

/** 校验导入根目录可写：存在、可穿越、可写；否则抛错。 */
async function assertImportDirWritable(rootDir: string): Promise<void> {
  const dir = resolve(process.cwd(), rootDir);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await access(dir);
    const probe = resolve(dir, `.write-probe-${Date.now()}.tmp`);
    await writeFile(probe, Buffer.allocUnsafe(0));
    await rm(probe);
  } catch (err) {
    throw new Error(
      `导入目录不可写（${dir}）：${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}
