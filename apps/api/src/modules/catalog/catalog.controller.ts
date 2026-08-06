// /catalog 端点：学习者只读浏览已发布课程、报名与主课程选择。
// 只读 courses.current_release_id → course_releases → released_units，不读草稿。
// 仅需登录会话（SessionGuard）；报名/主课程只作用于当前用户，管理员访问同样只得到学习者结果。
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { SessionGuard, type AuthenticatedRequest } from "../../auth/session.guard.js";
import { CourseService } from "./courses/course.service.js";
import {
  CatalogCourseDetailDto,
  CatalogCourseListResponseDto,
  EnrollCourseDto,
  SetPrimaryCourseDto,
} from "./courses/dto.js";

@ApiTags("catalog")
@Controller("catalog")
@UseGuards(SessionGuard)
export class CatalogController {
  constructor(private readonly courseService: CourseService) {}

  @Get("courses")
  @ApiBearerAuth()
  @ApiOperation({ summary: "学习者可见课程列表（只读 current release + 本人报名/主课程状态）" })
  @ApiOkResponse({ type: CatalogCourseListResponseDto })
  list(@Req() req: AuthenticatedRequest) {
    return this.courseService.listCatalogCourses(req.user.id);
  }

  @Get("courses/:id")
  @ApiBearerAuth()
  @ApiOperation({
    summary: "课程详情：当前 release、有序单元概要与本人报名/主课程状态；不可见返回 404",
  })
  @ApiOkResponse({ type: CatalogCourseDetailDto })
  get(@Req() req: AuthenticatedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.courseService.getCatalogCourse(req.user.id, id);
  }

  @Post("courses/:id/enroll")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: "加入已发布课程（幂等）；可选 makePrimary" })
  @ApiOkResponse({ type: CatalogCourseDetailDto })
  enroll(
    @Req() req: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: EnrollCourseDto,
  ) {
    return this.courseService.enroll(req.user.id, id, dto.makePrimary ?? false);
  }

  @Put("primary-course")
  @ApiBearerAuth()
  @ApiOperation({ summary: "把已报名课程设为主课程（事务内原子切换；未报名返回 409）" })
  @ApiOkResponse({ type: CatalogCourseDetailDto })
  setPrimary(@Req() req: AuthenticatedRequest, @Body() dto: SetPrimaryCourseDto) {
    return this.courseService.setPrimaryCourse(req.user.id, dto.courseId);
  }
}
