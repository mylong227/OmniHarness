// en 词条分片：零散组件（AddMenu/Pickers/WorkIndicator/RightPanel 等）。键 = 中文原文（与 t() 的键逐字一致，含 {name} 占位符）。
export const EN_MISC: Record<string, string> = {
  // AddMenu.tsx
  '添加': 'Add',
  '搜索文件或聊天…': 'Search files or chats…',
  '搜索中…': 'Searching…',
  '没有匹配的文件或聊天': 'No matching files or chats',
  '模式切换失败：{msg}': 'Failed to switch mode: {msg}',
  '设置要持续追求的目标（留空清除）：': 'Set a goal to keep pursuing (leave empty to clear):',
  '持续目标': 'Persistent goal',
  '保存': 'Save',
  '例如：把召回率提到 60%': 'e.g. Raise recall to 60%',
  '已选择智能体：{name}（载入会话后生效）': 'Agent selected: {name} (takes effect after the session loads)',
  // WorkIndicator.tsx
  '正在调用 {tool}': 'Calling {tool}',
  '思考中': 'Thinking',
  '刚刚': 'Just now',
  // Resizer.tsx
  '拖拽调整宽度': 'Drag to resize',
  // RightPanel.tsx（面板标签同 PanelPicker/PanelRegistry）
  '（点 × 回到文件）': ' (click × to return to files)',
  '关闭 {name}': 'Close {name}',
  ' 面板': ' panel',
  '文件与面板': 'Files & panels',
  '收起功能面板（Ctrl/Cmd+Shift+E）': 'Collapse panel (Ctrl/Cmd+Shift+E)',
  '收起功能面板': 'Collapse panel',
  // GraphResumeChip.tsx
  '↻ 续跑': '↻ Resume',
  '「{name}」': '"{name}"',
  '复用已完成 {done} 步的产出，只重跑剩下 {rest} 步（同一运行 id，进度会实时刷新）':
    'Reuse outputs of {done} completed steps and rerun only the remaining {rest} (same run id, progress refreshes live)',
  '复用已完成步骤的产出，只重跑未完成的步骤':
    'Reuse outputs of completed steps and rerun only the unfinished ones',
  // ModelPicker.tsx
  '模型': 'Model',
  '模型与推理强度': 'Model & reasoning effort',
  '模型与推理强度 · {name}': 'Model & reasoning effort · {name}',
  '选择模型与推理强度': 'Select model and reasoning effort',
  '可用模型': 'Available models',
  '当前': 'Current',
  '推理强度': 'Reasoning effort',
  ' · 该模型不支持': ' · not supported by this model',
  '推理强度 {name}': 'Reasoning effort {name}',
  '推理强度 {name}（当前值，该模型不支持）': 'Reasoning effort {name} (current value, not supported by this model)',
  '{name} · 该模型不支持这一档，点选其它档位即可切换':
    '{name} · not supported by this model; pick another level to switch',
  // PermissionPicker.tsx（档位文案同 PermissionTierModel 兜底表 / 后端 ApprovalTierCatalog）
  'AI 权限等级': 'AI permission level',
  '{title}｜{label}：{desc}': '{title} | {label}: {desc}',
  '完全访问': 'Full access',
  '完全访问：AI 可不受限制地访问你的文件和互联网':
    'Full access: AI can access your files and the internet without restriction',
  '默认': 'Default',
  '请求批准': 'Ask for approval',
  '计划模式': 'Plan mode',
  '全部拒绝': 'Deny all',
  '按规则自动放行安全操作；删除等危险命令仍会拒绝':
    'Automatically allows safe operations by rule; dangerous commands like deletion are still blocked',
  '编辑外部文件和使用互联网时始终询问':
    'Always ask when editing external files or using the internet',
  '只读规划：仅放行读取与检索类工具，不动工作区':
    'Read-only planning: only read and search tools are allowed; the workspace is untouched',
  '可不受限制地访问互联网和你电脑上的任何文件':
    'Can access the internet and any file on your computer without restriction',
  '拒绝一切工具调用（模型只对话，不产生任何副作用）':
    'Rejects all tool calls (the model only chats, with no side effects)',
  // PanelPicker.tsx / RightPanel.tsx（PanelRegistry 面板标签）
  '全部面板': 'All panels',
  '工具': 'Tools',
  '变更': 'Changes',
  '文件': 'Files',
  '指标': 'Metrics',
  '编排': 'Orchestration',
  '记忆': 'Memory',
  '配置集': 'Profiles',
  '治理': 'Governance',
  '回滚': 'Rollback',
  '钻取': 'Drilldown',
  '插件': 'Plugins',
  '诊断': 'Diagnostics',
  '审计': 'Audit',
  '权限': 'Permissions',
  '凭据': 'Credentials',
  // ContextCapacityPanel.tsx
  '上下文容量': 'Context usage',
  '上下文容量与今日余额': "Context usage & today's balance",
  '加载中…': 'Loading…',
  '缓存命中 {text}': 'Cache hit {text}',
  '今日余额': "Today's balance",
  '剩余 {text}': '{text} left',
  '重置': 'reset',
  '免费': 'Free',
  '档位 {name}': 'Plan {name}',
  '按模型 {model} 自动识别': 'Auto-detected from model {model}',
  '未识别到模型，按缺省档': 'No model detected; using the default plan',
  '（{reason}）': ' ({reason})',
  '容量数据加载失败：{msg}': 'Failed to load context usage: {msg}',
  // TraceView.tsx
  '工具调用轨迹': 'Tool call trace',
  '共 {count} 次工具调用': '{count} tool calls',
  ' · {count} 次进行中': ' · {count} running',
  '完成': 'Done',
  '进行中': 'Running',
  '本轮还没有工具调用。发起任务后，读取 / 编辑 / 命令会按顺序出现在这里。':
    'No tool calls in this turn yet. Once you start a task, reads / edits / commands will appear here in order.',
};
