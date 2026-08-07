// 发布版本分配（纯函数）：每门课程 release_number 从 1 单调递增。
// 并发安全由发布事务锁定草稿 + (course_id, release_number) 唯一约束兜底。

export function nextReleaseNumber(published: readonly number[]): number {
  if (published.length === 0) return 1;
  return Math.max(...published) + 1;
}

/**
 * 发布快照复制：解析单个 draft unit 在本版本中应复用的 released_unit 主键。
 * 已缓存（该单元已在本次发布中复制过）→ 直接返回；否则从 unitInsert 返回行取主键并缓存。
 * 若 INSERT 未返回 id（防御路径），抛异常让外层发布事务回滚，绝不提交不完整 release；
 * release rows 不可变，不得用 ON CONFLICT DO UPDATE 修补。
 * 提取为纯函数便于对失败路径做最小可测验证，不扩大架构。
 */
export function resolveReleasedUnitId(
  unitId: string,
  unitInsert: { rows: { id: string }[] },
  releasedUnitIds: Map<string, string>,
): string {
  let releasedUnitId = releasedUnitIds.get(unitId);
  if (!releasedUnitId) {
    releasedUnitId = unitInsert.rows[0]?.id;
    if (!releasedUnitId) {
      throw new Error(
        `released_units 复制失败：未获得单元 ${unitId} 的 released_unit id，已回滚本次发布`,
      );
    }
    releasedUnitIds.set(unitId, releasedUnitId);
  }
  return releasedUnitId;
}
