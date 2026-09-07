# 本地 Embedding 依赖评估（破 U3 语义鸿沟）

> 关联：U3 上下文召回实验（`docs/U3_CONTEXT_RECALL_EXPERIMENT.md`）· 依赖政策（`docs/DEPENDENCY_POLICY.md`）
> 评估日：2026-09-05 ｜ 状态：候选已定，依赖已按新铁律登记，生产接线待模型就绪

## 0. 为什么需要 embedding

U3 实测五轮，仅「词形归并（camelCase 拆分 + 词干化）」有效（文件召回 60.83%→67.0%，符号精度 13%→25.5%）。
但 BM25 是**词袋 / 词法**模型，存在结构性盲区——**语义同义但字面不同**的查询与代码无法命中：

- 查询 `authorization check` ↔ 代码里叫 `permissionGate` / `accessPolicy`
- 查询 `sanitize user input` ↔ 代码里叫 `escapeHtml` / `stripTags`
- 查询 `retry on failure` ↔ 代码里叫 `withBackoff`

这正是 U3 残留的 **policy vs execPolicy 语义鸿沟**：执行策略（execPolicy）用字面符号，检索策略（policy）用自然语言查询，二者在词法空间不相交。
BM25 补不了，但**稠密向量 embedding（语义空间）可以**。结论：用 embedding 做**语义召回**与 BM25 的**词法召回**互补（混合检索，hybrid retrieval），不替换既有零依赖 BM25。

## 1. 候选方案（2026 现状）

| 方案                                   | 许可证        | 运行方式                                    | 模型体积                                   | 是否需要联网           | 评价                                                                      |
| -------------------------------------- | ------------- | ------------------------------------------- | ------------------------------------------ | ---------------------- | ------------------------------------------------------------------------- |
| **`@huggingface/transformers` v4**     | Apache-2.0 ✅ | ONNX Runtime（WASM/WebGPU，免原生编译可选） | 模型 ~80MB（all-MiniLM-L6-v2，缓存至本地） | 首次下载模型，之后离线 | **推荐**：生态最成熟、API 稳定、WASM 路径免 MSVC                          |
| `fastembed-js` / `@fastembed/node`     | MIT           | ONNX Runtime 原生（需原生二进制）           | 模型 ~80MB                                 | 首次下载               | 质量相当，但强依赖原生 onnxruntime，安装门槛更高                          |
| 纯 WASM 自研（hash embedding）         | —             | 无模型                                      | 0                                          | 否                     | 零依赖但本质是词法哈希，质量约等于 BM25，**不算「真正好的依赖」**，故不选 |
| 云 API（OpenAI/Cohere text-embedding） | 商用条款      | 远程调用                                    | 0 本地                                     | 每次联网               | 违反「数据留本地 / 离线可用」原则，排除                                   |

**选定：`@huggingface/transformers` v4 + `Xenova/all-MiniLM-L6-v2`（384 维，Apache-2.0 模型权重）**。

理由：

1. **许可证洁净**：库 Apache-2.0，模型权重 Apache-2.0，过铁律 §2.4 阻断闸门。
2. **免原生编译**：`device: 'wasm'` 走 `onnxruntime-web`，不触发 `onnxruntime-node` 原生构建——对本机无 MSVC / 无 Rust 的环境友好（原生后端仍可用，但非必需）。
3. **离线可用**：模型首次从 HF Hub 下载后缓存到本地 `cacheDir`，之后 `localFilesOnly: true` 全程离线，契合本项目「使用条件更低」目标。
4. **可替换性**：所有调用收敛进一个适配器 `TransformersEmbeddingAdapter`，对外只暴露本项目 `EmbeddingPort`，符合铁律 §2.5（换包 = 改 1 个适配器文件）。

## 2. 体积预算说明（铁律 §2.2 / §2.3 超限，已显式审批）

`@huggingface/transformers` 安装体积远超默认预算（默认 `maxInstallKb: 2048` / `maxTransitiveDeps: 20`）：

- 库本体 ~9.5MB，但传递依赖含 `onnxruntime-node` / `onnxruntime-web` / `sharp` / `@huggingface/tokenizers` / `@huggingface/jinja`，安装态远超 2MB、传递依赖 > 20。
- **但体积预算是报告级（仅 `--strict` 阻断）**，且铁律 §1.1 明确「自研边际成本显著高于引入、能带来质变能力时允许引入，超出需显式说明理由」。
- 本依赖带来的是**质变能力（语义召回）**，自研等价物需训练/维护一个 embedding 模型，边际成本不可接受。
- 已在 `dependency-allowlist.json` 条目中覆盖 `maxInstallKb` / `maxTransitiveDeps` 并写明理由；运行时仅模型权重（数据资产，非代码依赖）落本地，不影响冷启动分发体积。

## 3. 架构接线（六边形端口-适配器）

```
src/ports/embedding.ts          EmbeddingPort（接口，第三方-free，核心/端口层不碰 transformers）
        ▲
        │ 依赖接口
src/context/semanticRecall.ts   SemanticRecallEngine（混合检索：BM25 ∪ 向量余弦），DI 注入 EmbeddingPort
        ▲
        │ 运行时装配（仅启用时）
src/adapters/embedding/transformersEmbedding.ts   TransformersEmbeddingAdapter
        │  lazy: await import('@huggingface/transformers')   // 动态导入，编译期不依赖该包
        ▼
   @huggingface/transformers (dependencies, 已登记)
```

- `EmbeddingPort` 落在 `src/ports/**`（端口层，第三方-free，只定义接口）——符合铁律分层隔离底线。
- 适配器落在 `src/adapters/embedding/**`，第三方只在这里出现。
- 适配器用**动态 `import()`**，因此项目编译/测试不要求该包已安装；仅在用户启用语义 embedding（`config.semanticEmbedding.enabled`）且运行时装配它时才加载。
- `SemanticRecallEngine` 用 DI 接收 `EmbeddingPort`，因此**可用 FakeEmbedding 单测**，无需 80MB 模型。

## 4. 混合检索策略

查询时：

1. BM25（词法）召回 top-K 文件/符号（既有能力，不动）；
2. Embedding 余弦召回 top-K（语义，补 U3 鸿沟）；
3. 两路结果按归一化分数融合（RRF 或加权），去重后产出 repo-map 片段。

索引期：符号/文件文本经 `EmbeddingPort.embed()` 成向量，随语料索引缓存（与 repo-map 现有 TTL/失效机制复用，避免每步重算）。

## 5. 退出路径（铁律 §4）

若 `@huggingface/transformers` 停更：替换为 `fastembed-js` 或自托管 ONNX runtime，仅需重写 `TransformersEmbeddingAdapter` 一个文件，端口与引擎不变。模型权重 `Xenova/all-MiniLM-L6-v2` 为社区标准、多运行时通用，无锁定。

## 6. 当前落地状态

- ✅ 评估完成，方案确定。
- ✅ `EmbeddingPort` + `SemanticRecallEngine` + `TransformersEmbeddingAdapter`(lazy) + 单测（FakeEmbedding）已落地并通过。
- ✅ `@huggingface/transformers` 已登记进 `dependency-allowlist.json`，并加入 `package.json` `dependencies`（按铁律 §3 流程）。
- ⏳ 运行时模型权重需首次联网下载（`Xenova/all-MiniLM-L6-v2`，约 80MB）后离线可用；在受限沙箱内 `npm install` 可能受网络/原生二进制限制，需在联网机器执行 `npm install` 一次。
- ⏳ 生产接线（repo-map 同时走语义召回）为下一步：待模型就绪后，在 `repoMapContext.getRepoMapContext` 支持可选 `embeddingPort`，与现有 BM25 走混合检索。
