// en 词条分片：流式区（stream/*、StreamView、markdown、textUtils）。键 = 中文原文（与 t() 的键逐字一致，含 {name} 占位符）。
export const EN_STREAM: Record<string, string> = {
  // StreamView.tsx
  '工具结果（独立事件）': 'Tool result (standalone event)',
  '— 上下文已压缩 · 游标 upTo={upTo} · 摘要约 {n} 字 · 点击查看 —':
    '— Context compacted · cursor upTo={upTo} · summary ~{n} chars · click to view —',
  '进行中…': 'Running…',
  '对话事件流': 'Conversation event stream',
  '等待任务': 'Waiting for a task',
  '下达任务后，模型推理、工具调用与结果将在此实时呈现。':
    'Model reasoning, tool calls and results will appear here in real time once you send a task.',
  '试试这些（点一下填进输入框，可改后再发）': 'Try these (click to fill the input, edit before sending)',
  '{n} 条事件': '{n} events',
  '已连接': 'Connected',
  '重连中': 'Reconnecting',
  '断开': 'Disconnected',

  // ArtifactCard.tsx
  '在右侧面板打开（语法高亮）': 'Open in right panel (syntax highlighted)',
  '在右侧面板打开': 'Open in right panel',
  '打开': 'Open',
  '下载到本地': 'Download to local',
  '下载产物': 'Download artifact',

  // AssistantCard.tsx
  '重新生成': 'Regenerate',
  '↻ 重新生成': '↻ Regenerate',
  '复制结果': 'Copy result',
  '复制': 'Copy',

  // CollapsibleDoc.tsx
  '约 {n} 字': '~{n} chars',
  '收起 ▴': 'Collapse ▴',
  '展开全文 ▾': 'Expand full text ▾',

  // ProcessCluster.tsx
  '过程进行中（自动展开）': 'In progress (auto-expanded)',
  '点击查看执行过程': 'Click to view execution process',
  '执行过程 — {text}': 'Process — {text}',
  '{n} 步': '{n} steps',

  // ReasoningBlock.tsx
  '正在思考': 'Thinking',
  '正在思考（已约 {n} 字）': 'Thinking (~{n} chars so far)',
  '{m}分{s}秒': '{m}m {s}s',
  '{s}秒': '{s}s',
  '思考中': 'Thinking',
  '{n} 字': '{n} chars',
  '收起': 'Collapse',
  '点击查看思考内容': 'Click to view reasoning',
  '思考过程 · {dur} · {n} 字': 'Reasoning · {dur} · {n} chars',
  '思考过程 · {n} 字': 'Reasoning · {n} chars',

  // StreamingAssistantCard.tsx
  '助手正在生成回复': 'Assistant is generating a reply',
  '助手正在生成回复（已约 {n} 字）': 'Assistant is generating a reply (~{n} chars so far)',
  '生成中…': 'Generating…',

  // ToolCallCard.tsx
  '成功': 'Success',
  '失败': 'Failed',
  '运行中…': 'Running…',
  '收起详情': 'Hide details',
  '点击查看调用详情': 'Click to view call details',
  '等待结果…': 'Waiting for result…',
  '在右侧钻取面板查看原始事件': 'View raw event in drill-down panel',
  '⤢ 在钻取面板查看': '⤢ View in drill-down panel',

  // TurnDiffCard.tsx
  '已编辑 {n} 个文件': 'Edited {n} files',
  '收起文件': 'Collapse files',
  '展开文件': 'Expand files',

  // UserCard.tsx
  '编辑重发：把这条消息填回输入框，改完回车重发':
    'Edit & resend: fills this message back into the input; press Enter to resend',
  '编辑重发': 'Edit & resend',

  // markdown.ts（与 AssistantCard 共用「复制」，勿重复添加）
  '已复制': 'Copied',

  // textUtils.ts — describeToolCall
  '写入 {path}': 'Write {path}',
  '写入文件': 'Write file',
  '修改 {path}': 'Edit {path}',
  '修改文件': 'Edit file',
  '读取 {path}': 'Read {path}',
  '读取文件': 'Read file',
  '浏览目录 {path}': 'Browse directory {path}',
  '浏览目录': 'Browse directory',
  '执行命令 {cmd}': 'Run command {cmd}',
  '执行命令': 'Run command',
  '搜索 {q}': 'Search {q}',
  '搜索代码': 'Search code',
  '查看计划': 'View plan',
  '更新计划': 'Update plan',
  '展示计划': 'Present plan',
  '更新待办': 'Update todos',
  '委派子任务 {task}': 'Delegate subtask {task}',
  '委派子任务': 'Delegate subtask',
  '{name}（{summary}）': '{name} ({summary})',
  '调用 {name}': 'Call {name}',

  // textUtils.ts — processSummary
  '思考 {n} 次': 'Thought {n} times',
  '读取了 {n} 个文件': 'Read {n} files',
  '写入了 {n} 个文件': 'Wrote {n} files',
  '执行了 {n} 条命令': 'Ran {n} commands',
  '浏览了 {n} 次目录': 'Browsed directories {n} times',
  '搜索了 {n} 次': 'Searched {n} times',
  '委派了 {n} 个子任务': 'Delegated {n} subtasks',
  '更新了 {n} 次计划': 'Updated plans {n} times',
  '{name}×{n}': '{name}×{n}',
  '{n} 个事件': '{n} events',

  // textUtils.ts — statusBadge / timeAgo
  '新增': 'Added',
  '删除': 'Delete',
  '重命名': 'Rename',
  '修改': 'Modified',
  '刚刚': 'Just now',
  '{n} 分钟前': '{n} minutes ago',
  '{n} 小时前': '{n} hours ago',
  '{n} 天前': '{n} days ago',
};
