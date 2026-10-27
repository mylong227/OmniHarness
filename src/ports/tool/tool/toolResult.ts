import type { FileAttachment } from '../../model/model.ts';

/** 工具执行结果。 */
export interface ToolResult {
  readonly callId: string;
  readonly ok: boolean;
  readonly output?: string | undefined;
  readonly error?: string | undefined;
  /**
   * 工具产出的**文件附件**（可选，P2-⑬）：供 `view_image` 这类「把字节交给模型」的工具使用。
   * 图片类附件由模型适配器作为图像理解；其余以文本说明注入模型上下文。
   *
   * 通道走向：工具结果事件 → 上下文组装器 → 模型消息。组装器会把它们作为**独立的一条
   * user 消息**追加在所有 tool 消息之后（而不是塞进 tool 消息内）——OpenAI 兼容端点不保证
   * tool 消息能携带分段内容，且把附件插在 tool 消息之间会破坏 tool_call 配对。
   */
  readonly files?: readonly FileAttachment[] | undefined;
  /**
   * 命令类工具的**真实退出码**（可选，2026-10-27）：仅当「子进程确实执行完」时由工具填写。
   *
   * 语义边界是**执行完成**而非成功：`exitCode !== 0` 表示命令跑完但返回非零——红测试、
   * `grep` 无命中、`git diff --exit-code` 等日常结果都属此类，**不是**工具健康失败；
   * 超时 / 被信号终止 / 进程起不来时子进程没有正常退出码，故**不填**此字段（仍算真实失败）。
   * 监督内核据此区分「命令结果」与「工具坏了」，避免一次红测试把会话推进 safe 自锁。
   */
  readonly exitCode?: number | undefined;
}
