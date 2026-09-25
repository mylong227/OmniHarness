---
'omniharness': minor
---

移除遗留记忆双引擎（ResonantMemoryEngine / CosmicWebMemoryEngine），统一到 U1 基板

按 0.2.0 弃用公告执行（DEFICIENCY_AUDIT §3.2 定案：与 U1 ResonantFieldEngine 同算法重复）：

- **删除** `ResonantMemoryEngine` / `CosmicWebMemoryEngine` 两适配器及其公开导出；
  配置块 `resonance` / `memoryWeb` 同步移除（它们只服务这两个引擎，删除后即成死旋钮）。
- **迁移路径**：U1 统一基板 `resonantField` 配置**默认开启**（单一状态源，合并燧-3 共振寻址
  与宇宙网黏附/坍缩，消除双重频谱索引）——绝大多数消费者无需任何改动；显式
  `resonantField.enabled: false` 时返回裸长期记忆（不再回落到遗留双引擎）。
- **新增公开导出** `ResonantFieldEngine` 与 `ResonantFieldOptions`/`ResonantFieldPort`，
  作为共振寻址的一等公开 API。
- 端口 `ResonantMemoryPort` / `CosmicWebPort` 不变（U1 基板继续实现二者）；
  `benchmark/compete_benchmark.mjs` 的旧引擎引用（含 C7 改名后的失配路径）迁移至 U1 引擎。
