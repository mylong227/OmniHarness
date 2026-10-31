// en 词条分片：输入区（Composer、CommandPalette、QuestionCard、ApprovalModal 及其控制器）。键 = 中文原文（与 t() 的键逐字一致，含 {name} 占位符）。
export const EN_COMPOSER: Record<string, string> = {
  // components/Composer.tsx
  '移除': 'Remove',
  '文件引用补全': 'File reference suggestions',
  '技能补全': 'Skill suggestions',
  '附件读取失败': 'Failed to read attachment',
  '{count} 个文件读取失败：{errors}': '{count} files failed to read: {errors}',
  '附件读取失败：{msg}': 'Failed to read attachment: {msg}',
  '任务输入区': 'Task input',
  '任务输入框：输入任务，Enter 发送，Shift+Enter 换行，@ 引用文件，/ 选择技能':
    'Task input: type a task, Enter to send, Shift+Enter for a new line, @ to reference files, / to pick a skill',
  '发消息或创建任务，/ 调用技能，@ 文件或对话':
    'Send a message or create a task, / for skills, @ for files or threads',
  '继续输入以排队后续修改': 'Keep typing to queue follow-up changes',
  '粘贴 / 拖拽 / 选择文件（项目内文件夹选择器风格）':
    'Paste / drag / pick files (project folder picker style)',
  '附加图片、视频或文件': 'Attach images, videos, or files',
  '停止语音输入': 'Stop voice input',
  '语音输入（中文）': 'Voice input (Chinese)',
  '开始语音输入': 'Start voice input',
  '停止生成': 'Stop generating',
  '插话': 'Steer',
  '插话（Enter 发送，下一步生效）': 'Steer (Enter to send, applies next step)',
  '发送任务': 'Send task',
  '发送（Enter）': 'Send (Enter)',

  // 聊天模式 / 队列坞（2026-10-31，队列 + 插话）
  '聊天模式': 'Chat mode',
  '发送方式': 'Send behavior',
  '队列模式': 'Queue mode',
  '插话模式': 'Steer mode',
  '任务进行中：Enter 插话；无关内容会中断并转新任务':
    'Task running: Enter to steer; unrelated content interrupts and starts a new task',
  '任务进行中：Enter 加入队列，结束后依次发送':
    'Task running: Enter to queue; messages are sent in order after it finishes',
  '加入队列': 'Add to queue',
  '加入队列（Enter 发送，当前任务结束后依次发出）':
    'Add to queue (Enter; sent in order after the current task)',
  '排队消息': 'Queued messages',
  '收起队列': 'Collapse queue',
  '展开队列，查看全部 {n} 条': 'Expand queue to view all {n}',
  '{n} 条排队': '{n} queued',
  '已暂停': 'Paused',
  '当前任务结束后发送': 'Sent after the current task',
  '即将发送': 'Sending next',
  '附件 {n} 个': '{n} attachments',
  '还有 {n} 条': '+{n} more',
  '队列已暂停（你点了停止）。继续后会接着发送。':
    'Queue paused (you pressed Stop). Resume to continue sending.',
  '继续发送': 'Resume sending',
  '排队中的全部消息': 'All queued messages',
  '置顶（下一条就发它）': 'Move to front (send next)',
  '置顶第 {n} 条': 'Move item {n} to front',
  '从队列删除': 'Remove from queue',
  '删除第 {n} 条': 'Remove item {n}',
  '按顺序逐条发送；点「停止」会暂停队列。':
    'Sent one by one in order; pressing Stop pauses the queue.',
  '清空队列': 'Clear queue',
  '收起': 'Collapse',
  '（仅附件，共 {n} 个）': '(attachments only, {n})',
  '（空消息）': '(empty message)',
  '正在生成，请稍候再发送': 'Still generating; please wait before sending',
  '已加入队列（{n} 条待发）': 'Queued ({n} pending)',
  '已并入当前任务，下一步生效': 'Merged into the current task; applies on the next step',
  '检测到新任务，已中断当前任务并转入新任务':
    'Detected a new task; interrupted the current one and switched',
  '聊天模式已生效，但保存失败（下次启动会回到上次保存的模式）':
    'Chat mode applied, but saving failed (next launch returns to the last saved mode)',
  '任务执行中再次发送消息时的处理方式。两种模式都支持文字、语音、图片、视频、GIF、文件与链接。':
    'How messages sent during a running task are handled. Both modes support text, voice, images, videos, GIFs, files, and links.',
  '队列模式：进入排队，当前任务结束后按顺序逐条发送；插话模式：相关内容并入当前任务继续执行，完全无关的内容立即中断并转入新任务。':
    'Queue mode: messages queue and are sent one by one after the current task; Steer mode: related content joins the current task, while unrelated content interrupts and starts a new task immediately.',


  // components/CommandPalette.tsx
  '命令面板': 'Command palette',
  '搜索命令或面板…': 'Search commands or panels…',
  '命令搜索框': 'Command search',
  '命令列表': 'Command list',
  '清除搜索': 'Clear search',
  '无匹配命令': 'No matching commands',
  '换个关键词试试': 'Try a different keyword',
  '选择': 'select',
  '执行': 'run',
  '↑↓ 选择，Enter 执行，Esc 关闭': '↑↓ to select, Enter to run, Esc to close',
  '{count} 个命令': '{count} commands',

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
  '工具参数': 'Tool arguments',
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
  '正在生成，请先停止': 'Still generating; stop the current turn first',
  '正在收尾上一回合，请稍候': 'The previous turn is still winding down; please wait',
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
  // 面板名（工具/指标/…）与分组名「面板」已在 misc 分片有词条，不再在此重复。
  会话: 'Sessions',
  界面: 'Interface',
  其他: 'Other',
  '刷新会话列表': 'Refresh session list',
  '打开设置': 'Open settings',
  '切换浅色 / 深色主题': 'Toggle light / dark theme',
  '切换会话面板': 'Toggle session panel',
  '切换工具面板': 'Toggle tools panel',
};
