# 周挑战榜交互原型（Throwaway）

问题：独立排行榜如何清楚地区分日常 XP 与客观测验积分，同时让用户完成一次 10 题、5 分钟、逐题反馈的测验？

在仓库根目录运行：

```sh
python3 -m http.server 4173 --directory prototype/challenge
```

打开 http://localhost:4173/。这是内存原型：排行榜 → 测验 → 即时反馈 → 结果可走通，刷新会重置；静态示例模拟 7 道可得分题和 3 道复习题。它不连接 API、不代表正式业务实现。
