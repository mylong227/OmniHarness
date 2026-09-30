import type { ToolInputDelta } from './toolInputDelta.js';

/** 模型流式回调。 */
export interface StreamCallbacks {
  readonly onText: (text: string) => void;
  /** 工具输入增量（可选；模型不支持或不触发工具时不调用）。 */
  readonly onToolInput?: (delta: ToolInputDelta) => void;
}
