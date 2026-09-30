/**
 * 嵌入端口（EmbeddingPort）：语义向量化能力的抽象边界。
 *
 * 设计要点（铁律 §2.5 分层隔离）：
 *  - 本文件位于 src/ports/**，第三方-free，只定义接口，绝不 import 任何 embedding 实现库。
 *  - 具体实现（@huggingface/transformers 等）只落在 src/adapters/embedding/**，
 *    对外仅暴露本端口类型，换实现 = 改 1 个适配器文件。
 *  - SemanticRecallEngine（src/context）只依赖本端口，因此可用 FakeEmbedding 单测，无需 80MB 模型。
 *
 * 本文件已退化为桶：4 个接口各自独立成文件于 `./embedding/`，调用点零改动。
 */

export type { Embedding } from './embedding/embedding.js';
export type { EmbedOptions } from './embedding/embedOptions.js';
export type { EmbeddingPreloadOutcome } from './embedding/embeddingPreloadOutcome.js';
export type { EmbeddingPort } from './embedding/embeddingPort.js';
