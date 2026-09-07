import type { ToolInputDelta } from './model.js';

/**
 * 工具输入实时观察端口（#B3 呈现层）。
 *
 * 与 `SessionRecorder` / `EventPort` 解耦：后者是 append-only 事实日志的广播，
 * 而本端口只承载模型流式生成的**过程性**工具参数增量——它不进入事实日志、
 * 不进检索索引，纯粹是给 UI（TUI / console / web）的瞬时观察刷新。
 *
 * 这样模型"边想边写参数"的过程能被实时渲染，又不污染"模型所见即所记"的事实源。
 */
export interface ToolInputSink {
  readonly name: string;
  /** 模型边生成工具参数边回调（partialJson 为已累积片段，可能不完整，由消费方自行拼接）。 */
  onToolInput(delta: ToolInputDelta): void;
}
