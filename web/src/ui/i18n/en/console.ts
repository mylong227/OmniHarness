// en 词条分片：工作台控制台（ConsoleModal / SettingsSurface / ConsoleUI / DesktopSettingsSection /
// 控制台注册表）。键 = 中文原文（与 t() 的键逐字一致，含 {name} 占位符）。
export const EN_CONSOLE: Record<string, string> = {
  // —— 外壳与导航 ——
  工作台控制台: 'Workbench console',
  返回工作区: 'Back to workspace',
  控制台导航: 'Console navigation',
  打开导航菜单: 'Open navigation menu',
  关闭导航菜单: 'Close navigation menu',
  当前位置: 'Current location',
  关闭控制台: 'Close console',
  基础设置: 'Base settings',
  'Agent 能力': 'Agent capabilities',
  数据与统计: 'Data & usage',
  本机工作区: 'Local workspace',
  未定位工作区: 'Workspace not located',
  已连接: 'Connected',
  重连中: 'Reconnecting',
  断开: 'Disconnected',
  本机偏好: 'Local preference',
  服务端配置: 'Server config',
  本会话: 'This session',
  未选择会话: 'No session selected',
  工作区: 'Workspace',
  服务端: 'Server',
  全局: 'Global',

  // —— 设置分栏标题与副标题 ——
  常规: 'General',
  '界面语言、工作区与会话范围': 'Language, workspace and session scope',
  外观: 'Appearance',
  '主题与界面宽度': 'Theme and UI width',
  模型与厂商: 'Model & providers',
  键盘快捷键: 'Keyboard shortcuts',
  '全局快捷键与输入框按键': 'Global shortcuts and composer keys',
  '审批模式、升级策略与参数级规则': 'Approval mode, escalation policy and parameter-level rules',

  // —— 功能面板标题与说明 ——
  活动: 'Activity',
  自动化: 'Automations',
  工具: 'Tools',
  变更: 'Changes',
  文件: 'Files',
  指标: 'Metrics',
  上下文: 'Context',
  编排: 'Graphs',
  记忆: 'Memory',
  配置集: 'Profiles',
  治理: 'Governance',
  回滚: 'Rollback',
  钻取: 'Inspect',
  插件: 'Plugins',
  诊断: 'Diagnostics',
  审计: 'Audit',
  Trace: 'Trace',
  权限: 'Permissions',
  凭据: 'Credentials',
  技能: 'Skills',
  '本会话的审批、变更与最近事件汇总': 'Approvals, changes and recent events in this session',
  '本会话的上下文构成与今日余额':
    "This session's context composition and today's balance",
  '可复用技能目录，按名称、描述与标签检索':
    'Reusable skills, searchable by name, description and tags',
  定时与事件触发的自动化任务: 'Scheduled and event-triggered automations',
  本次会话触发的工具调用与结果: 'Tool calls and results triggered in this session',
  '工作区文件变更与逐块暂存 / 还原': 'Workspace file changes with per-hunk staging / reverting',
  工作区文件的只读预览: 'Read-only preview of workspace files',
  '会话、事件、工具调用计数与 Token 消耗': 'Session, event and tool-call counts plus token usage',
  '多步编排图、运行进度与续跑': 'Multi-step graphs, run progress and resume',
  跨会话长期记忆的检索与维护: 'Search and maintain long-term memory across sessions',
  '配置集与 Bundle 的保存、应用、打包': 'Save, apply and package profiles and bundles',
  晋升台账与逐行独立复核: 'Promotion ledger with per-row verification',
  会话检查点与回滚: 'Session checkpoints and rollback',
  单条事件的原始载荷与钻取: 'Raw payload and drill-down for a single event',
  '已安装 / 可获取插件的管理': 'Manage installed and available plugins',
  'daemon 运行态与环境体检报告': 'Daemon status and environment health report',
  '审计事件哈希链（只追加）': 'Audit event hash chain (append-only)',
  '本会话的只读 trace 自省': 'Read-only trace introspection for this session',
  参数级权限规则编辑器: 'Parameter-level permission rule editor',
  '凭据保险库（只列名字，写后不回读）': 'Credential vault (names only; values are never read back)',

  // —— 数据范围提示（页面标题旁的 scope 徽标 hover） ——
  '本次会话已触发的工具调用；随回合实时追加。':
    'Tool calls triggered in this session; appended live as turns progress.',
  '当前工作区的文件变更（非 git 工作区按本会话事件聚合）。':
    "File changes in the current workspace (non-git workspaces aggregate this session's events).",
  '本会话的 token 消耗 + 进程级指标；随回合实时刷新。':
    "This session's token usage plus process metrics; refreshed live.",
  '本会话的上下文构成（含今日额度）；模型事件一到就刷新，5s 兜底。':
    "This session's context composition (including today's quota); refreshed on model events with a 5s fallback.",
  '工作区的编排图与运行态；运行进度实时推送。':
    'Workspace graphs and run state; progress is pushed live.',
  '长期记忆（跨会话共享；变更事件会实时刷新）。':
    'Long-term memory shared across sessions; refreshes on change events.',
  '配置集与插件组合（全局；应用/保存后刷新）。':
    'Profiles and plugin sets (global; refresh after apply/save).',
  '工作区 .omniharness/evolution 的晋升台账（逐行独立复核）。':
    "Promotion ledger under the workspace's .omniharness/evolution (reviewed row by row).",
  '本会话的检查点与回滚；切会话自动重载。':
    "This session's checkpoints and rollbacks; reloads when switching sessions.",
  '从本会话事件流中选中一条事件的详情。':
    "Details for the event selected in this session's stream.",
  '已安装 / 可获取插件（全局；安装后刷新）。':
    'Installed / available plugins (global; refresh after install).',
  '服务端进程与运行环境诊断（非会话数据）。':
    'Server process and runtime diagnostics (not session data).',
  '审计事件哈希链（全局、只追加）。': 'Audit event hash chain (global, append-only).',
  '工作区文件的只读预览。': 'Read-only preview of workspace files.',
  '凭据保险库（只列名字，写后不回读）。':
    'Credential vault (names only; values are never read back).',
  '本会话的只读 trace（按事件序列读取）。':
    'Read-only trace for this session (read by event sequence).',
  '参数级权限规则（写进 omniharness.json，全局生效）。':
    'Parameter-level permission rules (written to omniharness.json, global).',
  '全局数据。': 'Global data.',

  // —— 常规 ——
  界面: 'Interface',
  '语言切换即时生效，并随用户级配置持久化。':
    'Language changes apply instantly and persist to user-level config.',
  界面语言: 'Interface language',
  '选择应用 UI 的显示语言。': 'Choose the display language for the app UI.',
  中文: '中文',
  '工作区由启动参数或用户级配置决定，界面内不提供切换——改它等于换一整个项目上下文。':
    'The workspace is set by launch flags or user-level config and cannot be switched in the UI — that would replace the entire project context.',
  当前工作区: 'Current workspace',
  会话列表范围: 'Session list scope',
  '只影响左栏列表的筛选，不改变会话归属；「全部项目」会显示其它工作区的存档。':
    'Only filters the sidebar list; session ownership is unchanged. “All projects” also shows archives from other workspaces.',
  当前项目: 'Current project',
  全部项目: 'All projects',
  快捷键: 'Shortcuts',
  '全局组合键不劫持正文输入：必须同时按下 Ctrl 或 Cmd。':
    'Global chords never hijack prose input: they require Ctrl or Cmd.',
  全局快捷键: 'Global shortcuts',
  '命令面板、新建会话、左右栏开合、明暗切换。':
    'Command palette, new session, sidebar and right panel toggles, theme switch.',
  查看全部: 'View all',
  关于: 'About',
  '以上是默认位置；归属根由服务端 OMNI_HOME 决定（默认 ~/.omniharness），--workspace 只切项目。':
    'These are the defaults; the user-level root is decided by the server’s OMNI_HOME (default ~/.omniharness), and --workspace only switches the project.',
  产品: 'Product',
  配置文件: 'Config file',
  会话存档: 'Session archive',

  // —— 外观 ——
  主题: 'Theme',
  主题模式: 'Theme mode',
  '跟随系统时，系统在日落切暗色，界面自动跟随；显式选择则锁定。':
    'When following the system, the UI switches to dark at sunset; an explicit choice locks the theme.',
  '当前跟随系统：{theme}': 'Following the system now: {theme}',
  '已锁定为{theme}': 'Locked to {theme}',
  界面宽度: 'UI width',
  '这里与拖动分隔条改的是同一份本机偏好；窄屏（≤880px）下两栏是抽屉，宽度不生效。':
    'This edits the same local preference as dragging the splitter; on narrow screens (≤880px) both sidebars are drawers and width has no effect.',
  会话栏宽度: 'Session sidebar width',
  '范围 180–600 px，当前 {width} px': 'Range 180–600 px, currently {width} px',
  右侧面板宽度: 'Right panel width',
  '范围 180–760 px，当前 {width} px': 'Range 180–760 px, currently {width} px',

  // —— 模型与厂商 ——
  厂商接入: 'Providers',
  刷新: 'Refresh',
  重试: 'Retry',
  已配置: 'Configured',
  当前: 'Active',
  '检测失败：厂商未返回结果': 'Probe failed: the provider returned no result',
  '默认模型用于新会话；自定义端点留空即回落厂商默认端点。':
    'The default model is used for new sessions; an empty custom endpoint falls back to the provider default.',

  // —— 运行时 ——
  '适配器决定请求协议；沙箱决定命令在什么隔离层里执行。':
    'The adapter selects the request protocol; the sandbox selects the isolation layer for commands.',
  '工作区由启动参数或用户级配置决定（--workspace / ~/.omniharness/omniharness.json），界面内不提供切换。':
    'The workspace is set by launch flags or user-level config (--workspace / ~/.omniharness/omniharness.json) and cannot be switched in the UI.',

  // —— 权限 ——
  审批默认: 'Approval defaults',
  '这三档是全局默认；按命令 / 参数逐个放行或拦截在下方规则表里编辑。':
    'These three are global defaults; allow or block individual commands/arguments in the rule table below.',

  // —— 快捷键页 ——
  打开命令面板: 'Open command palette',
  新建会话: 'New session',
  '收起 / 展开会话栏': 'Toggle session sidebar',
  '收起 / 展开右侧面板': 'Toggle right panel',
  '切换明暗主题': 'Toggle light/dark theme',
  输入框与浮层: 'Composer & popovers',
  '快捷键是只读展示：本版本不提供自定义键位，避免与浏览器保留键冲突。':
    'Shortcuts are read-only in this version to avoid clashes with browser-reserved keys.',
  '发送消息（输入框）': 'Send message (composer)',
  '换行（输入框）': 'New line (composer)',
  '关闭浮层 / 对话框': 'Close popover / dialog',
  '在浮层与选择器里移动': 'Move within popovers and pickers',
  '在控制台与对话框内循环焦点': 'Cycle focus in the console and dialogs',
  '这些键由各自的组件实现，不是全局监听。':
    'These keys are handled by their components, not by global listeners.',

  // —— 桌面 ——
  应用信息: 'App info',
  '来自桌面桥的只读信息。': 'Read-only info from the desktop bridge.',
  版本: 'Version',
  平台: 'Platform',
  语言: 'Language',
  窗口与启动: 'Window & startup',
  关闭时最小化到托盘: 'Minimize to tray on close',
  '关闭窗口不结束会话与任务。': 'Closing the window does not end sessions or tasks.',
  开机启动: 'Launch at login',
  '登录系统后以托盘方式启动（Windows / macOS）。':
    'Start in the tray after you sign in (Windows / macOS).',
  更新: 'Updates',
  '更新由桌面应用的后台服务完成；下载完成后可在此安装并重启。':
    "Updates are handled by the desktop app's background service; once downloaded you can install and restart here.",
  '当前已是最新版本': 'Up to date',
  '当前构建未启用自动更新': 'Auto-update is disabled in this build',
  检查更新: 'Check for updates',
  下载更新: 'Download update',
  安装并重启: 'Install and restart',
  '日志目录与运行时排障入口。': 'Log directory and runtime troubleshooting entries.',
  日志: 'Logs',
  打开日志目录: 'Open log folder',
  诊断信息: 'Diagnostics',
  查看诊断信息: 'View diagnostics',
  重启Harness: 'Restart Harness',
  '只重启后台服务，不关闭窗口。':
    'Restarts the background service only, without closing the window.',
  '在安装版中打开，可在这里管理窗口行为与更新。':
    'Open the installed app to manage window behavior and updates here.',

  未提供原因: 'No reason provided',
  '暂无事件记录。': 'No events recorded yet.',

  // —— 杂项（控制台里复用的既有文案） ——
  '…': '…',
};
