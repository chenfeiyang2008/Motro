import { Module } from "@nestjs/common";
import { AuthModule } from "../../auth/auth.module.js";
import { databaseProvider } from "../../auth/database.provider.js";
import { CourseController } from "./courses/course.controller.js";
import { CourseService } from "./courses/course.service.js";
import { LexicalEntryController } from "./lexicon/lexical-entry.controller.js";
import { LexicalEntryService } from "./lexicon/lexical-entry.service.js";

// 课程/词条目录模块：管理员手工词条 + 课程草稿与单元。
// AuthModule 未导出 POOL，目录模块自声明同一 provider（独立连接池，避免循环依赖）。
@Module({
  imports: [AuthModule],
  controllers: [LexicalEntryController, CourseController],
  providers: [databaseProvider, LexicalEntryService, CourseService],
  exports: [LexicalEntryService, CourseService],
})
export class CatalogModule {}
