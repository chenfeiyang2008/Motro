// 健康占位页：通过版本化 API 边界访问 liveness，不可用时显示可恢复状态。
import { fetchHealth } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function HealthPage() {
  const health = await fetchHealth();
  return (
    <section>
      <h1>服务状态</h1>
      {health.ok ? (
        <p>API 正常（{health.body?.service ?? "unknown"}）。</p>
      ) : (
        <p>API 暂不可用（{health.error ?? "未知原因"}），请稍后重试。</p>
      )}
      <p>
        <a href="/">返回首页</a>
      </p>
    </section>
  );
}
