// /catalog 端点：学习者只读浏览已发布课程。
// 只读 courses.current_release_id → course_releases → released_units，不读草稿。
// 仅需登录会话（SessionGuard），管理员访问同样只得到学习者只读结果，不会越权看到草稿。
import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { SessionGuard } from "../../auth/session.guard.js";
import { CourseService } from "./courses/course.service.js";
import { CatalogCourseDetailDto, CatalogCourseListResponseDto } from "./courses/dto.js";

@ApiTags("catalog")
@Controller("catalog")
@UseGuards(SessionGuard)
export class CatalogController {
  constructor(private readonly courseService: CourseService) {}

  @Get("courses")
  @ApiBearerAuth()
  @ApiOperation({ summary: "学习者可见课程列表（只读 current release）" })
  @ApiOkResponse({ type: CatalogCourseListResponseDto })
  list() {
    return this.courseService.listCatalogCourses();
  }

  @Get("courses/:id")
  @ApiBearerAuth()
  @ApiOperation({ summary: "课程详情：当前 release 与有序单元概要；不可见返回隐藏资源 404" })
  @ApiOkResponse({ type: CatalogCourseDetailDto })
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.courseService.getCatalogCourse(id);
  }
}
