/**
 * @beta
 * 字段类型。
 */
export type FieldType = 'string' | 'number' | 'boolean' | 'object' | 'array';

/**
 * @beta
 * 字段 schema。
 */
export interface FieldSchema {
  readonly type: FieldType;
  readonly required?: boolean;
  readonly description?: string;
}

/**
 * @beta
 * 流式声明：方法执行期间服务端推送的通知。
 */
export interface StreamSchema {
  /** 推送的通知方法名。 */
  readonly event: string;
  /** 通知说明。 */
  readonly description?: string;
}

/**
 * @beta
 * 方法 schema。
 */
export interface MethodSchema {
  readonly name: string;
  readonly description: string;
  readonly params: Record<string, FieldSchema>;
  readonly result: Record<string, FieldSchema>;
  /** 有值即为流式方法：执行期间持续推送该通知。 */
  readonly stream?: StreamSchema;
}

/**
 * @beta
 * 协议 schema（单源真相，TS/Python SDK 均由它生成）。
 */
export interface ProtocolSchema {
  readonly jsonrpc: '2.0';
  readonly methods: readonly MethodSchema[];
}

/**
 * @beta
 * 单源协议 schema：app-server 方法集。
 */
export const protocolSchema: ProtocolSchema = {
  jsonrpc: '2.0',
  methods: [
    {
      name: 'threads.create',
      description: '创建线程并执行任务',
      params: { prompt: { type: 'string', required: true, description: '任务提示词' } },
      result: {
        threadId: { type: 'string', description: '线程 ID' },
        finalText: { type: 'string', description: '最终文本' },
        steps: { type: 'number', description: '回合步数' },
      },
      stream: {
        event: 'thread.event',
        description: '执行期间逐条推送会话事件（user/reasoning/tool_call/tool_result/assistant）',
      },
    },
    {
      name: 'threads.continue',
      description: '续跑线程',
      params: {
        threadId: { type: 'string', required: true, description: '线程 ID' },
        prompt: { type: 'string', required: true, description: '新提示词' },
      },
      result: {
        threadId: { type: 'string' },
        finalText: { type: 'string' },
        steps: { type: 'number' },
      },
      stream: { event: 'thread.event', description: '续跑期间逐条推送会话事件' },
    },
    {
      name: 'threads.fork',
      description: '分叉线程',
      params: {
        threadId: { type: 'string', required: true, description: '源线程 ID' },
        prompt: { type: 'string', required: true, description: '新提示词' },
      },
      result: {
        threadId: { type: 'string' },
        finalText: { type: 'string' },
        steps: { type: 'number' },
      },
      stream: { event: 'thread.event', description: '分叉执行期间逐条推送会话事件' },
    },
    {
      name: 'threads.get',
      description: '获取线程事件',
      params: { threadId: { type: 'string', required: true, description: '线程 ID' } },
      result: {
        threadId: { type: 'string' },
        items: { type: 'array', description: '事件列表' },
      },
    },
    {
      name: 'threads.rewind',
      description: '回退线程（截断到指定事件，重生成的服务端真回退）',
      params: {
        threadId: { type: 'string', required: true, description: '线程 ID' },
        keepEventId: { type: 'string', required: true, description: '保留到哪条事件（含）' },
      },
      result: {
        ok: { type: 'boolean', description: '是否成功回退' },
        kept: { type: 'number', description: '保留的事件条数' },
        dropped: { type: 'number', description: '丢弃的事件条数' },
        error: { type: 'string', description: '失败原因（ok=false 时）' },
      },
    },
    {
      name: 'turns.run',
      description: '运行回合（线程已存在则续跑）',
      params: {
        threadId: { type: 'string', description: '线程 ID（可选）' },
        prompt: { type: 'string', required: true, description: '提示词' },
      },
      result: {
        threadId: { type: 'string' },
        finalText: { type: 'string' },
        steps: { type: 'number' },
      },
      stream: { event: 'thread.event', description: '回合执行期间逐条推送会话事件' },
    },
    {
      name: 'approval.respond',
      description: '响应审批上行',
      params: {
        requestId: { type: 'string', required: true, description: '审批请求 ID' },
        decision: { type: 'string', required: true, description: 'allow 或 deny' },
      },
      result: { ok: { type: 'boolean', description: '是否成功' } },
    },
  ],
};
