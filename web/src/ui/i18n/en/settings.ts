// en 词条分片：设置弹窗（SettingsModal、ProviderCard、SettingsModel）。键 = 中文原文（与 t() 的键逐字一致，含 {name} 占位符）。
export const EN_SETTINGS: Record<string, string> = {
  // 外观栏（语言切换与主题同面板）
  主题: 'Theme',
  深色: 'Dark',
  浅色: 'Light',
  跟随系统: 'Follow system',
  '界面跟随系统的浅色 / 深色设置，系统切换时自动跟随。当前：':
    'Follows the system light/dark setting and updates live. Now: ',
  '已锁定为': 'Locked to ',
  '；选「跟随系统」可重新交给系统决定。':
    '. Choose “Follow system” to hand the decision back to the system.',
  '两套主题共用同一组 token（黑/白/灰），只交换明度方向；切换后立即生效并记住选择。':
    'Both themes share one token set (black/white/gray) with inverted lightness direction; changes apply instantly and are remembered.',
  语言: 'Language',
  中文: '中文',
  English: 'English',
  '界面文案即时切换并记住选择。': 'UI text switches instantly and your choice is remembered.',

  // 顶部与导航
  设置: 'Settings',
  '关闭设置': 'Close settings',
  '关闭（Esc）': 'Close (Esc)',
  设置分栏: 'Settings sections',
  模型: 'Model',
  '厂商接入、API Key、默认模型与自定义端点': 'Providers, API keys, default model and custom endpoint',
  运行时: 'Runtime',
  '适配器、工作区与沙箱执行环境': 'Adapter, workspace and sandbox execution environment',
  权限: 'Permissions',
  '审批模式、升级策略与免确认开关': 'Approval mode, escalation policy and confirmation toggle',
  外观: 'Appearance',
  '主题与界面密度': 'Theme and UI density',
  配置集: 'Profiles',
  '切换配置集、查看当前生效插件': 'Switch profiles and view active plugins',

  // 「模型」栏
  厂商接入: 'Providers',
  '{done}/{total} 已配置 Key': '{done}/{total} keys configured',
  '保存 Key → 检测（真实请求厂商端点）→ 启用。凭据由服务端打码存储，界面不回显原文。':
    'Save key → probe (a real request to the provider endpoint) → enable. Credentials are stored masked on the server and never shown in the UI.',
  '读取厂商目录…': 'Loading provider catalog…',
  已配置: 'Configured',
  当前: 'Active',
  '默认模型与端点': 'Default model & endpoint',
  '默认模型': 'Default model',
  '如 gpt-4o / deepseek-v4-flash': 'e.g. gpt-4o / deepseek-v4-flash',
  '留空则用厂商默认模型': 'Leave empty to use the provider default model',
  '自定义 Base URL': 'Custom base URL',
  'OpenAI 兼容端点（留空＝清除覆盖）': 'OpenAI-compatible endpoint (leave empty to clear the override)',
  '留空即回落厂商默认端点': 'Leave empty to fall back to the provider default endpoint',
  '模型适配器': 'Model adapter',
  '切换适配器会同时刷新可用模型清单': 'Switching the adapter also refreshes the available model list',
  沙箱: 'Sandbox',
  '命令执行环境的隔离方式': 'Isolation mode for command execution',

  // 「运行时」栏
  '适配器与执行环境': 'Adapter & execution environment',
  工作区: 'Workspace',
  当前工作区: 'Current workspace',
  '工作区由启动参数或用户级配置决定（`--workspace` / `~/.omniharness/omniharness.json`），界面内不提供切换——改它等于换一整个项目上下文。':
    'The workspace is set by launch args or user-level config (`--workspace` / `~/.omniharness/omniharness.json`); it cannot be switched here — changing it means a whole new project context.',

  // 「权限」栏
  审批: 'Approval',
  '审批模式': 'Approval mode',
  'auto 全自动 / rules 按规则 / ask 每次询问': 'auto = fully automatic / rules = by rules / ask = confirm each time',
  '升级审批': 'Escalation approval',
  '越权请求（提权/写盘等）的处理方式': 'How unauthorized requests (privilege escalation, disk writes, etc.) are handled',
  '自动审批（免人工确认）': 'Auto-approve (no manual confirmation)',
  '开启后不再弹出审批确认；危险操作仍受沙箱与规则约束':
    'No more approval prompts when on; dangerous operations are still constrained by the sandbox and rules',
  '参数级规则': 'Per-command rules',
  '上面三档是**全局默认**；要按命令/参数逐个放行或拦截（例如只允许 `git status`），在「权限」面板里编辑规则表。':
    'The three options above are **global defaults**; to allow or block specific commands/args (e.g. only `git status`), edit the rule table in the "Permissions" panel.',
  '打开权限规则面板': 'Open permission rules panel',

  // 「配置集」栏
  '配置集（Profile）': 'Profiles',
  应用配置集: 'Apply profile',
  '选择并应用…': 'Select and apply…',
  '应用后立即生效，当前生效插件见下': 'Takes effect immediately; active plugins shown below',
  当前生效插件: 'Active plugins',
  '（默认）': '(default)',
  '新建 / 删除 / 打包配置集在「配置集」面板里完成。': 'Create / delete / export profiles in the "Profiles" panel.',
  '打开配置集面板': 'Open profiles panel',
  '已应用配置集': 'Profile applied',
  '应用配置集失败：{msg}': 'Failed to apply profile: {msg}',
  '、': ', ',

  // 厂商卡片（ProviderCard）
  '● 当前使用': '● In use',
  '已保存 {key}，输入新值覆盖': 'Saved {key}; enter a new value to replace it',
  '输入 API Key': 'Enter API key',
  '保存 Key': 'Save key',
  检测: 'Probe',
  '{name} 可用模型': '{name} available models',
  启用此厂商: 'Enable this provider',
  '检测未通过：{msg}（保存有效 Key 后重试）': 'Probe failed: {msg} (save a valid key and retry)',
  '已保存 Key，点「检测」拉取真实可用模型清单': 'Key saved — click "Probe" to fetch the real available model list',
  '未配置 Key：保存 → 检测 → 启用后才会显示可用模型': 'No key configured: save → probe → enable to see available models',
  未知原因: 'unknown reason',

  // 保存与提示（SettingsModel / SettingsModal）
  已保存: 'Saved',
  '请输入 API Key': 'Please enter an API key',
  '{name} Key 未修改（输入新值才会覆盖）': '{name} key unchanged (enter a new value to overwrite)',
  '{name} Key 已保存（服务端打码存储）': '{name} key saved (stored masked on the server)',
  '保存失败：{msg}': 'Save failed: {msg}',
  '{name} 连通（{count} 个模型，来源 {source}）': '{name} connected ({count} models, from {source})',
  '{name} 不可用：{msg}': '{name} unavailable: {msg}',
  '检测失败：{msg}': 'Probe failed: {msg}',
  '没有可用模型，请先检测': 'No available models — run a probe first',
  '{name} 已启用（模型 {model}），下一条消息即生效': '{name} enabled (model {model}); takes effect on the next message',
  '启用失败：{msg}': 'Enable failed: {msg}',
};
