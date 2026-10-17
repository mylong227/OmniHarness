// en 词条分片：输入区（Composer、CommandPalette、QuestionCard、ApprovalModal 及其控制器）。键 = 中文原文（与 t() 的键逐字一致，含 {name} 占位符）。
export const EN_COMPOSER: Record<string, string> = {
  // components/Composer.tsx
  '移除': 'Remove',
  '文件引用补全': 'File reference suggestions',
  '附件读取失败': 'Failed to read attachment',
  '{count} 个文件读取失败：{errors}': '{count} files failed to read: {errors}',
  '附件读取失败：{msg}': 'Failed to read attachment: {msg}',
  '任务输入区': 'Task input',
  '任务输入框：输入任务，Enter 发送，Shift+Enter 换行，@ 引用文件':
    'Task input: type a task, Enter to send, Shift+Enter for a new line, @ to reference files',
  '发消息或创建任务，/ 调用指令，@ 文件或对话':
    'Send a message or create a task, / for commands, @ for files or threads',
  '粘贴 / 拖拽 / 选择文件（项目内文件夹选择器风格）':
    'Paste / drag / pick files (project folder picker style)',
  '附加图片、视频或文件': 'Attach images, videos, or files',
  '停止语音输入': 'Stop voice input',
  '语音输入（中文）': 'Voice input (Chinese)',
  '开始语音输入': 'Start voice input',
  '停止生成': 'Stop generating',
  '发送任务': 'Send task',
  '发送（Enter）': 'Send (Enter)',

  // components/CommandPalette.tsx
  '命令面板': 'Command palette',
  '输入命令或搜索…（↑↓ 选择，Enter 执行，Esc 关闭）':
    'Type a command or search… (↑↓ to select, Enter to run, Esc to close)',
  '命令搜索框': 'Command search',
  '命令列表': 'Command list',
  '无匹配命令': 'No matching commands',

  // components/QuestionCard.tsx
  '输入你的回答': 'Enter your answer',
  '其他 / 补充说明（可选）': 'Other / additional notes (optional)',
  '{title} — 补充说明': '{title} — additional notes',
  '第 {n} 题还没作答：请选一项或填写补充说明。':
    'Question {n} is unanswered: pick an option or add a note.',
  '待回答的提问': 'Questions awaiting your answer',
  '提问': 'Question',
  '已作答 {done}/{total}': 'Answered {done}/{total}',
  '剩余 {n} 秒': '{n}s left',
  '超时后模型会按「未作答」继续；作答随时可提交。':
    'After the timeout the model continues with "unanswered"; you can submit anytime.',
  '选择或填写后提交。': 'Select or type an answer, then submit.',
  '全部跳过': 'Skip all',
  '提交中…': 'Submitting…',
  '提交回答': 'Submit answers',

  // components/ApprovalModal.tsx
  '工具审批请求': 'Tool approval request',
  '工具：{name}': 'Tool: {name}',
  '目标：{name}': 'Target: {name}',
  '始终允许': 'Always allow',
  '拒绝': 'Deny',
  '允许': 'Allow',
  '更改权限': 'Change permission',

  // controllers/ComposerController.ts
  '。服务端等待超时，回合可能仍在后台继续；可稍候重新打开该会话查看结果，或点「停止」后再发一次。':
    '. The server timed out; the turn may still be running in the background. Reopen this thread later to check the result, or press "Stop" and send again.',
  '。': '.',
  '。可尝试切换模型或检查 API Key。': '. Try switching models or checking the API key.',
  '未知错误': 'Unknown error',
  '运行失败：{msg}': 'Run failed: {msg}',
  '运行失败：{msg}{hint}': 'Run failed: {msg}{hint}',
  '已中止（用户中断）。': 'Aborted (interrupted by user).',
  '正在生成，请先停止后再重生成': 'Still generating; stop the current turn before regenerating',
  '没有可重生成的用户消息': 'No user message to regenerate',
  '重生成失败（服务端未回退）：{reason}': 'Regeneration failed (server did not rewind): {reason}',
  '未知原因': 'unknown reason',
  '示例内容为空，已忽略': 'Sample content is empty; ignored',
  '没有可编辑的用户消息': 'No user message to edit',
  '已填回输入框，编辑后回车重发': 'Placed in the input box; edit and press Enter to resend',
  '切换模型失败：{msg}': 'Failed to switch model: {msg}',
  '切换推理强度失败：{msg}': 'Failed to switch reasoning effort: {msg}',
  '切换权限等级失败：{msg}': 'Failed to switch permission level: {msg}',

  // models/ComposerOptions.ts
  '无': 'None',
  '极简': 'Minimal',
  '弱': 'Low',
  '中': 'Medium',
  '强': 'High',
  '极强': 'Ultra',
  '极致': 'Max',

  // models/PendingModes.ts
  '尚未创建会话：该模式已记录，发送第一条消息后自动生效':
    'No thread yet: the mode has been saved and takes effect after you send the first message',

  // 命令面板消费的 buildCommands 标签（AppReducers 构造期拼接，渲染处 t(item.label)/t(g.group) 查表）。
  导航: 'Navigation',
  会话: 'Sessions',
  界面: 'Interface',
  其他: 'Other',
  '打开面板：工具': 'Open panel: Tools',
  '打开面板：指标': 'Open panel: Metrics',
  '打开面板：插件': 'Open panel: Plugins',
  '打开面板：编排': 'Open panel: Graph',
  '打开面板：记忆': 'Open panel: Memory',
  '打开面板：配置集': 'Open panel: Profiles',
  '打开面板：钻取': 'Open panel: Detail',
  '打开面板：变更': 'Open panel: Changes',
  '打开面板：回滚': 'Open panel: Rollback',
  '打开面板：文件': 'Open panel: Files',
  '刷新会话列表': 'Refresh session list',
  '打开设置': 'Open settings',
  '切换浅色 / 深色主题': 'Toggle light / dark theme',
  '切换会话面板': 'Toggle session panel',
  '切换工具面板': 'Toggle tools panel',
};
