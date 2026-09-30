import type { ModelRequest } from './modelRequest.js';
import type { ModelOutput } from './modelOutput.js';
import type { StreamCallbacks } from './streamCallbacks.js';

/** 模型端口：任意 AI（OpenAI 兼容 / Anthropic / 本地 / 自研）的统一插口。 */
export interface ModelPort {
  readonly name: string;
  generate(request: ModelRequest): Promise<ModelOutput>;
  stream?(request: ModelRequest, callbacks: StreamCallbacks): Promise<ModelOutput>;
}
