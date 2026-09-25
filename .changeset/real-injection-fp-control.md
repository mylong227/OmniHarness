---
'omniharness': patch
---

真注入基准补误报口径（重构对照）

`metrics:injection:real` 新增 FP 度量：direct 设置 1,054 条机械删除逐字嵌入的攻击指令重构出
干净工具输出（双重自证：无指令子串残留、无强触发语残留），实测护栏误报 **0.0%**（0/1054）。
结合召回结果（裸指令 0% / direct 0% / scenario 100%-by-boilerplate），词法护栏完整画像 =
零误报、零自然语言召回的纯触发语探测器。
