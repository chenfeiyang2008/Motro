import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Roles, RolesGuard } from "../../auth/roles.guard.js";
import { SessionGuard } from "../../auth/session.guard.js";
import { AdminOverviewDto } from "./overview.dto.js";
import { AdminOverviewService } from "./overview.service.js";

@ApiTags("admin overview")
@Controller("admin/overview")
@UseGuards(SessionGuard, RolesGuard)
@Roles("admin")
export class AdminOverviewController {
  constructor(private readonly service: AdminOverviewService) {}

  @Get()
  @ApiBearerAuth()
  @ApiOperation({ summary: "管理员首页概览（规模指标与待处理摘要）" })
  @ApiOkResponse({ type: AdminOverviewDto })
  get(): Promise<AdminOverviewDto> {
    return this.service.getOverview();
  }
}
