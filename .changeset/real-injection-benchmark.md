---
'omniharness': minor
---

T4.4 真提示注入基准出数（InjecAgent 官方数据集接入）

新增 `evals/injection-injecagent.mjs`（npm script `metrics:injection:real`）：把
`promptInjectionGuard#scanForInjection` 放到 InjecAgent 官方 2,108 条真实攻击呈现上量召回。
结果（@external）：裸攻击指令召回 0%、direct 设置 0%、scenario 设置 100%（场景模板触发语驱动）——
词法护栏对真实形态注入结构性不可见，「词法天花板」获官方数据集证据。不进主门禁（D4 不变）。
