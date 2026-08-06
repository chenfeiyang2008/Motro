// 发布版本分配（纯函数）：每门课程 release_number 从 1 单调递增。
// 并发安全由发布事务锁定草稿 + (course_id, release_number) 唯一约束兜底。

export function nextReleaseNumber(published: readonly number[]): number {
  if (published.length === 0) return 1;
  return Math.max(...published) + 1;
}
