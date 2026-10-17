// en 词条分片：杂项模型（models/ 下的视图与格式化器）。键 = 中文原文（与 t() 的键逐字一致，含 {name} 占位符）。
export const EN_MODELS_MISC: Record<string, string> = {
  // ContextUsageView.ts（运行时包装）
  '基于 {n} 次调用': '{n} calls',
  '端点未上报缓存字段': 'Endpoint did not report cache data',
  '端点未上报': 'Not reported',
  '首次请求': 'First request',
  '前缀被改写': 'Prefix rewritten',
  '缓存已过期': 'Cache expired',
  '原因不明': 'Unknown cause',
  '实测': 'Measured',
  '估算': 'Estimated',
  'MCP {mcp} · 系统 {sys}': 'MCP {mcp} · System {sys}',
  '{label} · {n} token': '{label} · {n} tokens',
  // ProviderStatus.ts（运行时包装）
  '可用 · {n} 个模型': 'Available · {n} models',
  '不可用 · {msg}': 'Unavailable · {msg}',
  '未配置 Key': 'No API key configured',
  '已保存 {key}（未实测）': 'Saved {key} (unverified)',
  '免 Key': 'No key needed',
  // QuotaView.ts（运行时包装）
  '升级 {n}% 配额': 'Upgraded {n}% quota',
  '基础预算 {base}/日': 'Base budget {base}/day',
  '基础预算 {base}/日 × {mult}': 'Base budget {base}/day × {mult}',
  '已用 {used} / {limit} token': 'Used {used} / {limit} tokens',
  '暂无模型级明细（厂商模型清单未就绪；合计用量见上方）':
    'No per-model details yet (provider model list not ready; see totals above)',
  '暂无模型级配额数据（未连接模型，或厂商模型清单未就绪）':
    'No per-model quota data (no model connected, or provider model list not ready)',
  '按本地日内 token 预算计算（非厂商账户余额）':
    'Computed from the local daily token budget (not the provider account balance)',
  // LongContentCollapser.ts（运行时包装）
  '长文内容': 'Long content',
  // WorkspacePath.ts（运行时包装）
  '未归属': 'Unassigned',
  // CheckpointTimeline.ts（运行时包装）
  '刚刚': 'Just now',
  '{n} 分钟前': '{n} minutes ago',
  '{n} 小时前': '{n} hours ago',
  '{n} 天前': '{n} days ago',
  '时间未知': 'Unknown time',
  '今天': 'Today',
  '昨天': 'Yesterday',
  // TokenScaleFormatter.ts（运行时包装；en 无等值数量级后缀，用倍率写法保住量级正确）
  '万': '×10K',
  '亿': '×100M',
  // AddMenuModel.ts（运行时包装）
  '添加': 'Add',
  '文件和文件夹': 'Files and folders',
  '计划模式': 'Plan mode',
  '开启计划模式': 'Enable plan mode',
  '绘图': 'Sketch',
  '绘制草图': 'Draw a sketch',
  '目标': 'Goal',
  '设置要持续追求的目标': 'Set a goal to pursue',
  '插件': 'Plugins',
  '正在加载插件…': 'Loading plugins…',
  '暂无已安装插件': 'No plugins installed',
  '智能体': 'Agents',
  '正在加载智能体…': 'Loading agents…',
  '暂无可用智能体': 'No agents available',
  '文件和聊天': 'Files and chats',
  '输入内容以搜索文件或聊天': 'Type to search files or chats',
  '没有匹配的文件或聊天': 'No matching files or chats',
  '（已开启）': ' (on)',
  // context.ts（运行时包装）
  'useApp 必须在 AppContext.Provider 内使用': 'useApp must be used within AppContext.Provider',
  // PanelRegistry.ts（顶层常量，值保持原文；需消费侧渲染时补 t()）
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
  '诊断': 'Diagnostics',
  '审计': 'Audit',
  '权限': 'Permissions',
  '凭据': 'Credentials',
  // PermissionTierModel.ts（顶层常量，值保持原文；需消费侧渲染时补 t()）
  '默认': 'Default',
  '请求批准': 'Ask for approval',
  '完全访问': 'Full access',
  '全部拒绝': 'Deny all',
  '按规则自动放行安全操作；删除等危险命令仍会拒绝': 'Automatically allows safe operations by rule; dangerous commands like deletion are still blocked',
  '编辑外部文件和使用互联网时始终询问':
    'Always ask when editing external files or using the internet',
  '只读规划：仅放行读取与检索类工具，不动工作区': 'Read-only planning: only read and search tools are allowed; the workspace is untouched',
  '可不受限制地访问互联网和你电脑上的任何文件': 'Can access the internet and any file on your computer without restriction',
  '拒绝一切工具调用（模型只对话，不产生任何副作用）': 'Rejects all tool calls (the model only chats, with no side effects)',
};
