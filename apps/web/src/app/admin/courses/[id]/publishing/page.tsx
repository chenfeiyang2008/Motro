"use client";

// 发布准备页：校验课程草稿，展示阻断错误、警告、差异摘要与影响人数；
// 校验通过后输入发布说明并确认发布不可变版本；展示版本历史并支持切换当前版本指针。
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import {
  listCourseReleases,
  publishCourseRelease,
  setCourseCurrentRelease,
  validateCourseDraft,
  type CourseValidationResult,
  type ReleaseListItem,
} from "@/lib/api";

type Issue = CourseValidationResult["blockingErrors"][number];

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
  if (path === "course.title") {
    return `/admin/courses/${courseId}/draft#metadata`;
  }
  return `/admin/courses/${courseId}/draft`;
}

function IssueList({
  title,
  issues,
  courseId,
  tone,
}: {
  title: string;
  issues: Issue[];
  courseId: string;
  tone: "blocking" | "warning";
}) {
  if (issues.length === 0) return null;
  return (
    <section className="publishing-section">
      <h2>{title}</h2>
      <ul className="issue-list">
        {issues.map((issue) => (
          <li key={`${issue.code}-${issue.path}`} className={`issue-item ${tone}`}>
            <span className="issue-code">{issue.code}</span>
            <span className="issue-message">{issue.message}</span>
            <code className="issue-path">{issue.path}</code>
            <Link href={fixLinkFor(courseId, issue.path)} className="issue-fix">
              去修复
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function CoursePublishingPage() {
  const params = useParams<{ id: string }>();
  const courseId = typeof params.id === "string" ? params.id : "";
  const [result, setResult] = useState<CourseValidationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [releaseNote, setReleaseNote] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState<{
    releaseNumber: number;
    contentHash: string;
    createdAt: string;
  } | null>(null);

  const [releases, setReleases] = useState<ReleaseListItem[]>([]);
  const [historyError, setHistoryError] = useState("");

  async function runValidation(): Promise<void> {
    setLoading(true);
    setError("");
    const res = await validateCourseDraft(courseId);
    setLoading(false);
    if (!res.ok || !res.data) {
      setError(res.error?.message ?? "校验失败，请重试");
      return;
    }
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

  async function publish(): Promise<void> {
    if (!result || !result.isPublishable) return;
    const nextNumber =
      result.diffSummary.kind === "initial" ? 1 : (releases[0]?.releaseNumber ?? 0) + 1;
    if (
      !window.confirm(
        `发布后将创建不可修改的版本 ${nextNumber}。已发布内容无法编辑或删除。确定发布吗？`,
      )
    ) {
      return;
    }
    setPublishing(true);
    setError("");
    const res = await publishCourseRelease(
      courseId,
      {
        draftVersion: result.draftVersion,
        releaseNote,
        validationToken: result.validationToken,
      },
      crypto.randomUUID(),
    );
    setPublishing(false);
    if (!res.ok || !res.data) {
      setError(res.error?.message ?? "发布失败，请重试");
      return;
    }
    setPublished({
      releaseNumber: res.data.releaseNumber,
      contentHash: res.data.contentHash,
      createdAt: res.data.createdAt,
    });
    setReleaseNote("");
    void loadHistory();
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

  return (
    <section>
      <p>
        <Link href={`/admin/courses/${courseId}/draft`}>返回草稿编排</Link>
      </p>
      <h1>发布准备</h1>

      <div className="publishing-toolbar">
        <button
          type="button"
          className="primary"
          disabled={loading}
          onClick={() => void runValidation()}
        >
          {loading ? "校验中…" : "校验课程"}
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
        </p>
      )}

      {result && (
        <>
          <p
            className={`publishing-status ${
              result.isPublishable ? "form-inline-success" : "form-inline-error"
            }`}
            role="status"
          >
            {result.isPublishable ? "草稿可发布" : "草稿存在阻断错误，暂不可发布"}
            {result.blockingErrors.length === 0 && result.warnings.length > 0
              ? "（存在需要注意的警告）"
              : ""}
          </p>

          <IssueList
            title="阻断错误"
            issues={result.blockingErrors}
            courseId={courseId}
            tone="blocking"
          />
          <IssueList title="警告" issues={result.warnings} courseId={courseId} tone="warning" />

          <section className="publishing-section">
            <h2>差异摘要</h2>
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
            <p>受影响的当前学习者：{result.affectedLearnerCount}</p>
          </section>

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
                  onClick={() => void publish()}
                >
                  {publishing ? "发布中…" : "发布版本"}
                </button>
              </div>
              {published && (
                <p className="form-inline-message form-inline-success" role="status">
                  已创建不可修改的版本 {published.releaseNumber}（内容哈希{" "}
                  {published.contentHash.slice(0, 12)}… ·{" "}
                  {new Date(published.createdAt).toLocaleString("zh-CN")}）。
                </p>
              )}
            </section>
          ) : null}

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
                        {" · "}内容哈希：{release.contentHash.slice(0, 12)}…
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
