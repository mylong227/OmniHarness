/**
 * 工具名**单一来源**（审计 §3.4「扩展接缝是改一处漏一处」的收口）。
 *
 * ## 为什么（用户指令：不要在代码里硬编码，方便以后维护）
 *
 * 工具名字面量此前散落在实现里：注册侧每个工具类各写一遍（`name: 'read_file'`），
 * 消费侧的策略表也各写一遍（`MUTATING_TOOLS`、调度器串行屏障、plan 模式只读白名单、
 * 工具输出信任分级、diff 钩子、默认审批规则、评估夹具…）。问题是**两头都写**：
 * 改一个工具名要改多处，而漏改策略表不会报错——只会让「写类工具必须串行 / plan 模式必须拦」
 * 这类安全契约对该工具静默失效（§20.8 就实测过 `rollback | read_file | remember` 同批并发）。
 *
 * 现把名字收进本文件：**工具标识在全仓只出现一次**，其余地方一律走 `TOOL_NAMES.*`。
 * 新增工具时先在此登记，再让工具类 `name: TOOL_NAMES.xxx`——`tests/unit/toolNames.test.ts`
 * 会核对「每个已注册工具类都在本表内」，漏登记即测试失败。
 *
 * ## 为什么在 `ports/`（而不是 `core/` 或 `config/`）
 *
 * 消费方横跨 core / adapters / security / cli / eval：`adapters/**` 与 `security/**` 都
 * **不得 import `core/`**（架构门禁 [1]/[2] 与 §20.8 的注释），只有端口层是共同的下游。
 * 本文件是纯常量 + 纯类型（无 class、无第三方、无业务逻辑），符合端口纯度要求。
 */

/**
 * 工具名常量表：键为语义名（camelCase），值为**注册用的工具标识**（模型看到的字符串）。
 *
 * 改动纪律：值是**对外契约**（模型据此调用、配置/审批规则据此匹配、评测集据此断言），
 * 改名属破坏性变更，须同时看顾 `omniharness.json` 里的 `permission.rules[].toolName`、
 * `--defer-tools` 列表与 `docs/` 中的工具清单。
 */
export const TOOL_NAMES = {
  /** 读文件。 */
  readFile: 'read_file',
  /** 列目录。 */
  listDir: 'list_dir',
  /** 文件名 glob 匹配。 */
  glob: 'glob',
  /** 内容检索（正则）。 */
  grep: 'grep',
  /** 写文件（整文件覆盖）。 */
  writeFile: 'write_file',
  /** 精确字符串替换编辑。 */
  edit: 'edit',
  /** 应用 unified diff 补丁。 */
  applyPatch: 'apply_patch',
  /** 前台命令执行。 */
  shell: 'shell',
  /** 后台作业管理（启动/查询/kill）。 */
  shellJob: 'shell_job',
  /** 交互式 PTY（vim/htop 等）。 */
  shellInteractive: 'shell_interactive',
  /** 一次性代码执行（沙箱内跑片段）。 */
  runCode: 'run_code',
  /** 委派给 worker。 */
  delegate: 'delegate',
  /** 派生子智能体。 */
  subagent: 'subagent',
  /** 网页截图落盘。 */
  browserScreenshot: 'browser_screenshot',
  /** 回滚工作区文件 / 截断事件流。 */
  rollback: 'rollback',
  /** 落盘检查点快照。 */
  checkpoint: 'checkpoint',
  /** 写长期记忆。 */
  remember: 'remember',
  /** 读长期记忆。 */
  recall: 'recall',
  /** 长期记忆检索。 */
  memorySearch: 'memory_search',
  /** 写待办清单。 */
  todoWrite: 'todo_write',
  /** 读待办清单。 */
  todoRead: 'todo_read',
  /** 读计划。 */
  planRead: 'plan_read',
  /** 写计划。 */
  planWrite: 'plan_write',
  /** 提交计划供批准。 */
  planPresent: 'plan_present',
  /** 向用户提问。 */
  askUser: 'ask_user',
  /** 按需发现延迟加载的工具。 */
  toolSearch: 'tool_search',
  /** 读回已外溢的大结果。 */
  spillRead: 'spill_read',
  /** 写草图便签。 */
  budgetStatus: 'budget_status',
  /** 写草图便签（延续上下文用）。 */
  sketchWrite: 'sketch_write',
  /** 查看图片。 */
  viewImage: 'view_image',
  /** 联网搜索。 */
  webSearch: 'web_search',
  /** 抓取网页。 */
  webFetch: 'web_fetch',
  /** 策略求值（只读）。 */
  policyEval: 'policy_eval',
  /** Agent 密码学身份（只读）。 */
  agentIdentity: 'agent_identity',
  /** 自主目标循环（编排入口）。 */
  runGoal: 'run_goal',
  /** DAG 工作流编排（编排入口）。 */
  runWorkflow: 'run_workflow',
  /** 插件注册表工具族外壳（`RegistryToolPort`）。 */
  registry: 'registry',
  // ---- LSP 只读查询族（原名常量在 `adapters/lsp/lspToolNames.ts`，现统一指向本表）----
  /** 跳到定义。 */
  lspGoToDefinition: 'lsp_go_to_definition',
  /** 查引用。 */
  lspFindReferences: 'lsp_find_references',
  /** 悬停信息。 */
  lspHover: 'lsp_hover',
  /** 语言服务器状态。 */
  lspStatus: 'lsp_status',
  /** 诊断。 */
  lspDiagnostics: 'lsp_diagnostics',
  /** 文档符号。 */
  lspDocumentSymbols: 'lsp_document_symbols',
  /** 代码动作。 */
  lspCodeAction: 'lsp_code_action',
  /** 工作区符号。 */
  lspWorkspaceSymbols: 'lsp_workspace_symbols',
} as const;

/** 工具名联合类型（字面量并集，便于穷举与收窄）。 */
export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

/**
 * **写类工具**（单一口径）：会改动工作区文件或持久状态，因而必须
 * ① 在计划模式（`plan`）被拦、② 在监督内核 safe/locked 模式被否、③ 在调度器形成**串行屏障**。
 *
 * 三处消费者共用本集合，避免历史上「两套口径各说各话」：
 * `core/toolGate.ts`（计划模式拦截）、`composition/runtime.ts`（注入 `SupervisorKernel.hazardousTools`）、
 * `core/loop/toolScheduler.ts`（串行屏障）。
 *
 * 收录判据（改动前请先读 §20.8 与 toolGate 的历史注释）：**会落盘、会改事件流、会持久化记忆，
 * 或能在真终端跑任意命令**即属写类——宁可多收（多一次串行）不可漏收（并发写互相覆盖）。
 */
export const MUTATING_TOOL_NAMES: ReadonlySet<ToolName> = new Set<ToolName>([
  TOOL_NAMES.shell,
  // 交互式 PTY：能在真终端里跑任意命令（vim/htop 等）⇒ 与 shell 同级。
  TOOL_NAMES.shellInteractive,
  // 后台作业管理：能 kill 进程、能启动任意命令 ⇒ 与 shell 同级。
  TOOL_NAMES.shellJob,
  TOOL_NAMES.writeFile,
  TOOL_NAMES.edit,
  TOOL_NAMES.applyPatch,
  TOOL_NAMES.delegate,
  TOOL_NAMES.subagent,
  // 网页截图落盘 PNG ⇒ 与 write_file 同级。
  TOOL_NAMES.browserScreenshot,
  // 还原工作区文件 + 截断事件流 ⇒ 与 write_file 同级。
  TOOL_NAMES.rollback,
  // 落盘检查点快照（含工作区文件内容）⇒ 写状态。
  TOOL_NAMES.checkpoint,
  // 写长期记忆（跨会话持久 fact）⇒ 有持久副作用。
  TOOL_NAMES.remember,
]);
