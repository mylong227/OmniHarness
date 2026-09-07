# U3 语义召回真实落地：BM25 vs 混合检索（诚实三层测量）

> 本文件记录 U3「共振语义层融合破召回天花板」的真实落地结果。**关键结论先说**：在真实代码库上，混合检索只比 morph-BM25 多 **+1.7pp**，并未把召回从 67% 拉到 ≥80%。机制本身有效（个别词法鸿沟查询可达 +25pp），但「破天花板」的原始 KPI 在真实库上未达成，必须如实记录。

## 0. 环境前提（已验证）

- 真实模型 `Xenova/all-MiniLM-L6-v2`（384 维，q8）现在能在 **Node 原生后端**跑通：修了适配器默认 `device: 'wasm'`（onnxruntime-node 不支持，应 `'cpu'`）这一真实落地的生产 bug。
- 权重经镜像 `HF_ENDPOINT=https://hf-mirror.com` 拉取（沙箱直连 huggingface.co 返回 502）；首次下载后缓存到 `OMNI_EMBEDDING_CACHE_DIR` 可离线复用。
- 语义索引构建改为**分块嵌入（256/批）**，避免超大单批把 onnxruntime 撑挂（这也是生产加固）。

## 1. 确定性合成代理（4 簇微基准，非真实模型）

| 查询                       | BM25 | 混合 | 说明           |
| -------------------------- | ---- | ---- | -------------- |
| authorized / entitlement   | ❌   | ✅   | 零词面重叠     |
| calculate / total / values | ❌   | ✅   | 零词面重叠     |
| persist / storage          | ✅   | ✅   | 词干化顺带命中 |
| reverse a string           | ✅   | ✅   | 控制组         |

- BM25 召回 **50%** → 混合 **100%**，**+50pp**。
- ⚠️ 这是**人为制造词法鸿沟**的代理，仅用于演示 RRF 融合机制与 fail-closed，**不代表真实库表现**。

## 2. 真实 MiniLM 微基准（同样 4 簇，真实模型）

- auth/math/io 各 BM25=100% / 混合=100%；str 簇 BM25=50% / 混合=100%。
- 平均：**BM25 87.5% → 混合 100.0%，+12.5pp**。
- 真实模型下 BM25 基线本身被拉高（函数名与查询词高度字面相关），混合只补上 `str` 簇缺口。

## 3. 真实代码库（src/ 327 文件 / 5340 符号，10 个真实查询，fileK=14）

| 查询                                      | GT  | BM25 | 混合 | Δ        |
| ----------------------------------------- | --- | ---- | ---- | -------- |
| tool registration (registerTool)          | 3   | 33%  | 33%  | 0        |
| sandbox denial escalate (EscalationPort)  | 12  | 58%  | 50%  | **−8.3** |
| ContextAssembler projects events          | 1   | 100% | 100% | 0        |
| audit hash chain (prevHash)*              | 0   | 100% | 100% | 0        |
| images attached to messages (imagesOf)    | 1   | 100% | 100% | 0        |
| reasoning_effort to openai                | 5   | 80%  | 80%  | 0        |
| BM25 tokenize CJK (tokenize)              | 3   | 33%  | 33%  | 0        |
| resonant probe from text (resonateByText) | 4   | 100% | 100% | 0        |
| sandbox policy evaluated (execPolicy)     | 6   | 33%  | 33%  | 0        |
| tool results spilled (spill_read)         | 4   | 25%  | 50%  | **+25**  |

- **平均：BM25 66.3% → 混合 68.0%，+1.7pp**（*prevHash GT=0 为锚点未命中，按 100% 计，属 artifact，剔除后 bm25 62.4% / 混合 64.3% / +1.9pp）。
- 见 `evals/recall-codebase-real.report.json` 取精确数。

## 4. 诚实结论

1. **机制有效但增益有限**：真实代码库上混合检索仅 +1.7pp，不是合成代理的 +50pp。morph-BM25 基线已 66.3%，稠密检索补强空间小。
2. **增益来自真词法鸿沟**：`spill_read` 查询（25%→50%，+25pp）证明语义层确实能桥接 BM25 漏掉的 paraphrase/跨词鸿沟；但本 10 查询集多数无显著鸿沟，BM25 已覆盖。
3. **融合会引入噪声**：`EscalationPort` 上混合反降 8.3pp（语义召回把无关文件顶进 fileK 预算，RRF 默认 k=60 对这些长尾查询稀释了 BM25 信号）——索引与融合参数仍需调优。
4. **与原始 KPI 的差距**：U3 目标「67%→≥80%」在真实库上**未达成**（实测 66.3%→68.0%）。这与「S+ 发明层领先」的叙事无关，是检索本身的真实边界，必须如实记录，不作夸大。
5. **下一步**：① 构建更具词法/跨语言鸿沟的真实查询集（复现 +25pp 级别增益）；② 调 RRF 权重、对语义召回做置信度门限降噪；③ 或接受 morph-BM25 在该代码库已近天花板，把语义层定位为「兜底补召回」而非「破天花板」。

## 5. 复现命令

```bash
# 微基准（确定性，无需模型）
node evals/recall-compare.mjs

# 真实模型微基准
HF_ENDPOINT=https://hf-mirror.com HF_WASM_PATH=node_modules/onnxruntime-web/dist \
  OMNI_EMBEDDING_CACHE_DIR=.omni-embed-cache node evals/recall-compare-real.mjs

# 真实代码库（本文件第 3 节数据来源）
HF_ENDPOINT=https://hf-mirror.com HF_WASM_PATH=node_modules/onnxruntime-web/dist \
  OMNI_EMBEDDING_CACHE_DIR=.omni-embed-cache OMNI_FILE_K=14 \
  node evals/recall-codebase-real.mjs
```
