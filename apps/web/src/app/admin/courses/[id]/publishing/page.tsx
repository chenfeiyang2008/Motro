"use client";

// Ticket 08 发布工作流页（在既有发布准备页上扩展，接入真实 validate+publish API）。
// 信息层级（严格遵守）：
//   - AI 草稿 / 未审核 / manual_action 未处理 → 不可发布
//   - rejected → 不可发布（明确显示"已拒绝"）
//   - accepted / accepted_with_edits → 仅表示审核接受，≠ 可发布
//   - provenance 不完整 → fail closed（显示具体缺项）
//   - eligible（服务端 isPublishable 判定）→ 仅此时显示发布按钮
//   - published → 显示 release number 与时间（以服务端响应为唯一事实源）
// 敏感字段绝不展示：prompt / provider response / key / secret / 原始模型 payload /
//   hash 明文 / 存储路径 / 内部数据库字段 / 原始 Wiktionary 文本。
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import {
  listCourseReleases,
  publishCourseRelease,
  setCourseCurrentRelease,
  validateCourseDraft,
  type CourseValidationResult,
  type ReleaseListItem,
} from "@/lib/api";
import { categorizeBlockers, groupItemBlockers } from "@/lib/publication-state";

/** 根据校验 path 生成返回编辑页的修复链接。 */
function fixLinkFor(courseId: string, path: string): string {
  if (path.startsWith("item.")) {
    const itemId = path.split(".")[1];
    if (itemId) return `/admin/courses/${courseId}/draft#item-${itemId}`;
  }
  if (path.startsWith("unit.")) {
    const unitId = path.split(".")[1];
    if (unitId) return `/admin/courses/${courseId}/draft#unit-${unitId}`;
  }
  if (path === "course.title") return `/admin/courses/${courseId}/draft#metadata`;
  return `/admin/courses/${courseId}/draft`;
}

export default function CoursePublishingPage() {
  const params = useParams<{ id: string }>();
  const courseId = typeof params.id === "string" ? params.id : "";
  const [result, setResult] = useState<CourseValidationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [publishErrorCode, setPublishErrorCode] = useState<"409" | "422" | "network" | null>(null);

  const [releaseNote, setReleaseNote] = useState("");
  const [publishing, setPublishing] = useState(false);
  const publishInFlight = useRef(false);
  const [published, setPublished] = useState<{
    releaseNumber: number;
    contentHash: string;
    currentReleaseId: string;
    createdAt: string;
  } | null>(null);

  const [releases, setReleases] = useState<ReleaseListItem[]>([]);
  const [historyError, setHistoryError] = useState("");

  // 每次校验结果固定的发布意图键：重试复用同一键，绝不新建。
  const intentKeyRef = useRef<string>(crypto.randomUUID());

  const itemBlockers = useMemo(
    () =>
      result
        ? groupItemBlockers(result.blockingErrors)
        : new Map<string, { code: string; message: string; path: string }[]>(),
    [result],
  );
  const blockedItems = useMemo(
    () => [...itemBlockers.entries()].map(([itemId, reasons]) => ({ itemId, reasons })),
    [itemBlockers],
  );
  const states = useMemo(
    () => categorizeBlockers(blockedItems, result?.diffSummary.totalItems ?? 0),
    [blockedItems, result?.diffSummary.totalItems],
  );

  async function runValidation(): Promise<void> {
    setLoading(true);
    setError("");
    setPublishErrorCode(null);
    setPublished(null);
    const res = await validateCourseDraft(courseId);
    setLoading(false);
    if (!res.ok || !res.data) {
      setError(res.error?.message ?? "校验失败，请重试");
      return;
    }
    // 一次校验 → 固定发布意图键（重试/刷新此校验结果后复用同一键）。
    intentKeyRef.current = crypto.randomUUID();
    setResult(res.data);
    void loadHistory();
  }

  async function loadHistory(): Promise<void> {
    const res = await listCourseReleases(courseId);
    if (res.ok && res.data) {
      setReleases(res.data.items);
      setHistoryError("");
    } else {
      setHistoryError(res.error?.message ?? "版本历史加载失败");
    }
  }

  /** 发布确认层：展示课程、release number、词项数与阻塞摘要后确认。 */
  function publishIntent(): void {
    if (!result || !result.isPublishable || publishInFlight.current) return;
    const nextNumber =
      result.diffSummary.kind === "initial" ? 1 : (releases[0]?.releaseNumber ?? 0) + 1;
    const confirmText = [
      `将创建不可修改的版本 ${nextNumber}（草稿版本 ${result.draftVersion}）。`,
      `词项数量：${result.diffSummary.totalItems}；单元：${result.diffSummary.totalUnits}。`,
      "已发布内容无法编辑或删除。",
    ].join("\n");
    if (!window.confirm(confirmText)) return;
    void doPublish();
  }

  async function doPublish(): Promise<void> {
    if (!result || !result.isPublishable || publishInFlight.current) return;
    publishInFlight.current = true;
    setPublishing(true);
    setError("");
    setPublishErrorCode(null);
    try {
      const res = await publishCourseRelease(
        courseId,
        {
          draftVersion: result.draftVersion,
          releaseNote,
          validationToken: result.validationToken,
        },
        intentKeyRef.current,
      );
      if (!res.ok || !res.data) {
        const code = res.status === 409 ? "409" : res.status === 422 ? "422" : "network";
        setPublishErrorCode(code);
        setError(
          res.error?.message ??
            (code === "409"
              ? "发布冲突：草稿版本已过期或该发布意图已被用于不同请求，请重新校验后重试。"
              : code === "422"
                ? "发布被拒绝：资格阻塞，请查看下方词项状态。"
                : "网络失败，请重试（将复用同一发布意图键）。"),
        );
        return;
      }
      setPublished({
        releaseNumber: res.data.releaseNumber,
        contentHash: res.data.contentHash,
        currentReleaseId: res.data.currentReleaseId,
        createdAt: res.data.createdAt,
      });
      setReleaseNote("");
      void loadHistory();
      // 发布成功后此意图已用，下次发布重置新键。
      intentKeyRef.current = crypto.randomUUID();
    } finally {
      publishInFlight.current = false;
      setPublishing(false);
    }
  }

  async function switchCurrent(releaseId: string, releaseNumber: number): Promise<void> {
    if (!window.confirm(`把当前版本切换到版本 ${releaseNumber}？历史版本本身不会被修改。`)) return;
    setError("");
    const res = await setCourseCurrentRelease(courseId, releaseId);
    if (!res.ok) {
      setError(res.error?.message ?? "切换当前版本失败");
      return;
    }
    void loadHistory();
  }

  const eligibleCount = result?.isPublishable ? states.eligibleCount : 0;

  return (
    <section>
      <p>
        <Link href={`/admin/courses/${courseId}/draft`}>返回草稿编排</Link>
      </p>
      <h1>发布工作流</h1>

      <div className="publishing-toolbar">
        <button
          type="button"
          className="primary"
          disabled={loading}
          onClick={() => void runValidation()}
        >
          {loading ? "校验中…" : "校验发布资格"}
        </button>
        {result && (
          <span className="publishing-version">
            草稿版本：{result.draftVersion}
            {result.validatedAt
              ? ` · 校验时间：${new Date(result.validatedAt).toLocaleString("zh-CN")}`
              : ""}
          </span>
        )}
      </div>

      {error !== "" && (
        <p className="form-inline-message form-inline-error" role="alert">
          {error}
          {publishErrorCode === "network" && (
            <button
              type="button"
              className="secondary retry-button"
              disabled={publishing}
              onClick={() => void doPublish()}
            >
              重试发布
            </button>
          )}
        </p>
      )}

      {!result && !loading && (
        <p className="empty-hint">点击「校验发布资格」查看该课程词项的发布状态与阻塞原因。</p>
      )}

      {result && (
        <>
          <p
            className={`publishing-status ${result.isPublishable ? "form-inline-success" : "form-inline-error"}`}
            role="status"
          >
            {result.isPublishable
              ? `资格就绪：${eligibleCount} 个词项可发布`
              : `存在 ${blockedItems.length} 个词项/阻断项不可发布`}
          </p>

          {/* 词项发布资格面板（fail-closed；服务端阻断原因分类） */}
          <section className="publishing-section" aria-label="词项发布资格">
            <h2>词项发布资格</h2>
            {blockedItems.length === 0 ? (
              <p className="form-inline-success">
                全部词项 source/revision/provenance 完整，均具备发布资格。
              </p>
            ) : (
              <ul className="issue-list">
                {states.provenanceIncomplete.map((it) => (
                  <li key={`prov-${it.id}`} className="issue-item blocking">
                    <span className="issue-code">PROVENANCE_INCOMPLETE</span>
                    <span className="issue-message">来源/provenance 不完整：{it.reason}</span>
                    <Link href={fixLinkFor(courseId, `item.${it.id}`)} className="issue-fix">
                      去处理
                    </Link>
                  </li>
                ))}
                {states.manualActionUnresolved.map((it) => (
                  <li key={`ma-${it.id}`} className="issue-item blocking">
                    <span className="issue-code">MANUAL_ACTION</span>
                    <span className="issue-message">需要人工处理（不可自动发布）：{it.reason}</span>
                    <Link href={fixLinkFor(courseId, `item.${it.id}`)} className="issue-fix">
                      去审核
                    </Link>
                  </li>
                ))}
                {states.rejected.map((it) => (
                  <li key={`rej-${it.id}`} className="issue-item blocking">
                    <span className="issue-code">REJECTED</span>
                    <span className="issue-message">已拒绝（不可发布）：{it.reason}</span>
                    <Link href={fixLinkFor(courseId, `item.${it.id}`)} className="issue-fix">
                      查看
                    </Link>
                  </li>
                ))}
                {states.otherBlocked.map((it) => (
                  <li key={`oth-${it.id}`} className="issue-item blocking">
                    <span className="issue-code">BLOCKED</span>
                    <span className="issue-message">{it.reason}</span>
                    <Link href={fixLinkFor(courseId, `item.${it.id}`)} className="issue-fix">
                      去处理
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* 差异摘要 */}
          <section className="publishing-section">
            <h2>发布快照预览</h2>
            <p>
              {result.diffSummary.kind === "initial"
                ? "首次发布（initial）"
                : "相对当前版本有差异（changed）"}
              ：共 {result.diffSummary.totalUnits} 个单元、{result.diffSummary.totalItems}{" "}
              个课程词项。
              {result.diffSummary.kind === "initial"
                ? " 本课程还没有已发布版本。"
                : ` 新增 ${result.diffSummary.addedUnits} 单元 / ${result.diffSummary.addedItems} 词项，移除 ${result.diffSummary.removedUnits} 单元 / ${result.diffSummary.removedItems} 词项。`}
            </p>
            <p>
              内容哈希：{result.contentHash.slice(0, 16)}…（发布后冻结） · 受影响学习者：
              {result.affectedLearnerCount}
            </p>
          </section>

          {/* 发布操作：仅 eligible 显示 */}
          {result.isPublishable ? (
            <section className="publishing-section">
              <h2>发布</h2>
              <label htmlFor="release-note">发布说明（可选）</label>
              <input
                id="release-note"
                value={releaseNote}
                onChange={(e) => setReleaseNote(e.target.value)}
                maxLength={500}
              />
              <div className="form-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={publishing}
                  onClick={() => void publishIntent()}
                >
                  {publishing ? "发布中…" : "确认发布版本"}
                </button>
              </div>
              {publishErrorCode === "409" && (
                <p className="form-inline-message form-inline-error" role="alert">
                  发布冲突：草稿版本已过期或被并发推进。请重新校验后再发布。
                </p>
              )}
              {publishErrorCode === "422" && (
                <p className="form-inline-message form-inline-error" role="alert">
                  发布被拒绝：词项资格未通过。请修复下方词项状态后重试。
                </p>
              )}
              {published && (
                <p className="form-inline-message form-inline-success" role="status">
                  已创建不可修改版本 {published.releaseNumber}（内容哈希{" "}
                  {published.contentHash.slice(0, 12)}… · 当前版本：
                  {published.currentReleaseId.slice(0, 8)}… ·{" "}
                  {new Date(published.createdAt).toLocaleString("zh-CN")}）。
                </p>
              )}
            </section>
          ) : null}

          {/* 版本历史 */}
          <section className="publishing-section">
            <h2>版本历史</h2>
            {historyError !== "" && (
              <p className="form-inline-message form-inline-error" role="alert">
                {historyError}
              </p>
            )}
            {releases.length === 0 ? (
              <p className="empty-hint">还没有发布版本。</p>
            ) : (
              <ul className="release-list">
                {releases.map((release) => (
                  <li key={release.id} className="release-item">
                    <div>
                      <strong>版本 {release.releaseNumber}</strong>
                      {release.isCurrent && <span className="release-current"> · 当前版本</span>}
                      <p className="release-meta">
                        {release.createdAt
                          ? new Date(release.createdAt).toLocaleString("zh-CN")
                          : ""}
                        {" · "}发布说明：{release.releaseNote || "—"}
                        {" · "}创建者：{release.createdByUsername}
                      </p>
                    </div>
                    {!release.isCurrent && (
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => void switchCurrent(release.id, release.releaseNumber)}
                      >
                        设为当前版本
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </section>
  );
}
