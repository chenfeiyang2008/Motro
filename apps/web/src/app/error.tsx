"use client";

// 错误边界：不向用户暴露原始异常。
export default function ErrorBoundary({ reset }: { error: Error; reset: () => void }) {
  return (
    <section>
      <h1>出错了</h1>
      <p>页面加载失败，请重试。</p>
      <button type="button" onClick={reset}>
        重试
      </button>
    </section>
  );
}
