// 学习者首页占位：进入已发布课程目录。
import Link from "next/link";

export default function LearnerHomePage() {
  return (
    <section>
      <h1>Motro</h1>
      <p>学习端。</p>
      <p>
        <Link href="/courses">课程</Link>
      </p>
    </section>
  );
}
