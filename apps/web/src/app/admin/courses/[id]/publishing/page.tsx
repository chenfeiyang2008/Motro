"use client";

// 发布准备页：校验课程草稿，展示阻断错误、警告、草稿版本、差异摘要与影响人数。
// 有阻断错误时不显示可执行的“发布版本”；无阻断错误时仅显示占位入口（发布在后续工单实现）。
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { validateCourseDraft, type CourseValidationResult } from "@/lib/api";

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
              <button type="button" className="primary" disabled title="发布功能将在后续工单实现">
                发布版本
              </button>
              <p className="empty-hint">发布功能将在后续工单实现；当前仅完成草稿校验。</p>
            </section>
          ) : null}
        </>
      )}
    </section>
  );
}
