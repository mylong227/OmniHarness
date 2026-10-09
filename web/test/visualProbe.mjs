// 视觉探针（无第三方依赖，真实 Chrome + CDP）：把 OmniHarness Web 工作台在**两套主题 × 两档视口**
// 下渲染成 PNG，存档到 web/archive/，供设计评审与"有没有变脏"的肉眼复核。
//
// 为什么必须有它（而不是只看单测）：
//   · 对比度门禁只保证"读得清"，不保证"好看"——灰底灰字、层级倒挂、留白失衡都是合法 CSS；
//   · 本仓前端零打包器、零 dev server，任何样式改动最终都要在真 Chrome 里看一眼才算数；
//   · 视觉回归靠"图 + 人眼"最能发现漂移，而单测看不见颜色以外的观感。
//
// 路线与 responsiveProbe / virtualProbe 完全同源（复用 ./browserHarness.mjs）：
//   1. 无第三方依赖静态服务托管 web/ + 注入假后端的 CDP stub 页（RPC 结果被本探针**覆盖**为
//      完整业务形状：会话 / 变更 / 指标 / 文件树 / 用量，否则页面只能看到空态）；
//   2. headless Chrome（--remote-debugging-port）→ Node 22 内置 WebSocket 直连 CDP；
//   3. Emulation.setDeviceMetricsOverride 精确设定视口；
//   4. **每个「主题 × 面板」组合都从 `Page.reload` 重新开始**：右栏面板里任何一个渲染期异常都会被
//      RenderErrorBoundary 接住并**卸载整棵树**（这是设计如此——降级成可读错误面板），
//      若在同一页里连点面板，一次崩溃就会把后面所有截图变成错误面板页（实测踩过）。
//
// 这是探针而非门禁：异常也 exit 0；找不到浏览器/受限沙箱起不来则打印 SKIP 并 exit 0。
// 用法：node web/test/visualProbe.mjs [--panes=tools,metrics] [--themes=dark] [--widths=1280]
// 环境变量：OMNI_CHROME_PATH 指定浏览器；OMNI_PROBE_WS 直连既有 CDP page target。

import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findBrowser,
  serveStatic,
  stubHtmlCdp,
  getFreePort,
  launchChromeForCdp,
  killChromeTree,
  waitForPageWs,
  CdpSession,
  WEB_ROOT_PATH,
} from './browserHarness.mjs';

const STUB_NAME = '_visual-probe-stub.html';
const ARCHIVE = join(WEB_ROOT_PATH, 'archive');
const HEIGHT = 900;

/** 打印一行 JSON（stdout，机器可读）。 */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** 受限沙箱回退启动器：stdio 改 'ignore'（同 responsiveProbe 口径）。 */
function launchChromeNoPipe(browser, url, userDataDir, port) {
  const args = [
    '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox',
    '--no-proxy-server', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-crash-reporter', '--disable-breakpad',
    '--user-data-dir=' + userDataDir, '--window-size=1280,' + HEIGHT,
    '--remote-debugging-port=' + port, url,
  ];
  return spawn(browser, args, { stdio: 'ignore' });
}

/**
 * 假后端结果覆盖：给 stub 的 /rpc 一份**完整业务形状**的数据。
 *
 * 诚实边界：数字与文案是**探针夹具**（不是真实遥测），故一律用 `probe-*` 前缀与整百数，
 * 避免被误读为真实统计。时间用固定基准 + 相对偏移，保证多次运行截图可比。
 * @returns {Record<string, unknown>} 方法名 → 结果
 */
function probeResults() {
  const base = Date.UTC(2026, 5, 6, 9, 30, 0);
  const iso = (minutesAgo) => new Date(base - minutesAgo * 60000).toISOString();
  return {
    'config.get': { modelAdapter: 'probe', model: 'probe-large', reasoning: 'medium', approval: 'ask' },
    // workspace.list → { current, workspaces: string[] }（**不是**对象数组）。
    'workspace.list': {
      current: 'D:\\deepseek\\omniharness',
      workspaces: ['D:\\deepseek\\omniharness', 'D:\\deepseek\\other-project'],
    },
    // sessions.list → { dir, sessions: [{ sessionId, label, turns, updatedAt, … }] }。
    'sessions.list': {
      dir: '~/.omniharness/sessions',
      sessions: [
        { sessionId: 'probe-s1', label: '打磨工作台视觉层', turns: 12, updatedAt: iso(4) },
        { sessionId: 'probe-s2', label: '接入新的权限档位校验', turns: 6, updatedAt: iso(90) },
        { sessionId: 'probe-s3', label: '排查长会话滚动跳动', turns: 21, updatedAt: iso(60 * 26) },
        { sessionId: 'probe-s4', label: '写审计链的端到端回归', turns: 4, updatedAt: iso(60 * 50) },
      ],
    },
    // changes.list → { source, branch, files: [{ path, status, additions, deletions }] }。
    'changes.list': {
      source: 'git',
      branch: 'main',
      files: [
        { path: 'web/styles/polish.css', status: 'A', additions: 1840, deletions: 0 },
        { path: 'web/src/ui/models/Icon.ts', status: 'A', additions: 186, deletions: 0 },
        { path: 'web/src/ui/components/NavRail.tsx', status: 'M', additions: 22, deletions: 12 },
        { path: 'web/index.html', status: 'M', additions: 4, deletions: 1 },
        { path: 'web/styles/legacy-theme-backup.css', status: 'D', additions: 0, deletions: 93 },
        { path: 'docs/DESIGN_SYSTEM.md', status: 'M', additions: 12, deletions: 2 },
      ],
    },
    'usage.stats': {
      source: 'live',
      dir: '',
      total: { calls: 128, prompt: 412000, completion: 96000, total: 508000 },
      byModel: {
        'probe-large': { calls: 104, prompt: 352000, completion: 81200, total: 433200 },
        'probe-small': { calls: 24, prompt: 60000, completion: 14800, total: 74800 },
      },
      sessions: [],
    },
    'fs.list': {
      tree: [
        { name: 'web', path: 'web', kind: 'dir', children: [
          { name: 'styles', path: 'web/styles', kind: 'dir', children: [
            { name: 'polish.css', path: 'web/styles/polish.css', kind: 'file' },
            { name: 'theme.css', path: 'web/styles/theme.css', kind: 'file' },
          ] },
          { name: 'index.html', path: 'web/index.html', kind: 'file' },
        ] },
        { name: 'src', path: 'src', kind: 'dir', children: [
          { name: 'cli', path: 'src/cli', kind: 'dir', children: [] },
        ] },
        { name: 'README.md', path: 'README.md', kind: 'file' },
      ],
    },
    'plugins.list': {
      plugins: [
        { id: 'probe-git', name: 'probe-git', version: '1.4.0', description: '版本控制工具集：状态、提交、差异审查。', source: 'bundled', loaded: true, permissions: ['fs.read', 'fs.write'] },
        { id: 'probe-search', name: 'probe-search', version: '0.9.2', description: '远端代码检索与仓库索引。', source: 'remote', loaded: false, permissions: ['network'] },
        { id: 'probe-shell', name: 'probe-shell', version: '2.0.1', description: '受限 shell 执行器，带审批闸门。', source: 'local', loaded: true, permissions: ['shell', 'fs.delete'] },
      ],
    },
    'agents.list': { agents: [{ id: 'probe-a1', name: 'probe-reviewer', description: '只读评审代理' }] },
    // fs.browse 是**联合类型**：不传 path 时回 drives 层。形状必须给全（缺字段会被前端判为
    // 格式异常——那条 fail-closed 判据见 web/test/pickerShapeGuard.test.mjs）。
    'fs.browse': {
      level: 'drives',
      roots: ['C:\\', 'D:\\'],
      home: 'C:\\Users\\probe',
    },
    'graph.list': [
      { id: 'probe-dag-1', name: 'sample-research', stepCount: 4 },
      { id: 'probe-dag-2', name: 'release-checklist', stepCount: 6 },
    ],
    // 运行返回的 runId 必须与下面 graph.progress 推送的 runId 一致：运行态按 runId 建键
    // （`applyGraphProgress` 用 `p.runId` 取/建运行），两边不一致时推来的进度会落进**另一个**运行，
    // 探针就只看到「芯片存在」而看不到任何真实状态（这正是本夹具此前的假绿形态，2026-10-08 修）。
    'graph.run': { runId: 'probe-run-1', nodeCount: 4 },
    // 续跑：服务端沿用同一 runId（本场景点「续跑」后据此断言卡片复位成「运行中…」）。
    'graph.resume': { runId: 'probe-run-1', nodeCount: 4 },
    'graph.status': {
      runId: 'probe-run-1',
      defName: 'sample-research',
      done: false,
      nodes: [
        { id: 'plan', status: 'done' },
        { id: 'a', status: 'done' },
        { id: 'b', status: 'running' },
        { id: 'merge', status: 'pending' },
      ],
    },
    // 形状必须与 MemoryListResult 一致（`{count, facts}`）——`facts` 缺了会在渲染期读
    // `undefined.length` 抛错，被 RenderErrorBoundary 接住后整棵树被卸载（探针里表现为
    // "后面的面板按钮全都找不到"）。
    'memory.list': {
      count: 2,
      facts: [
        { id: 'm1', text: '前端样式改动一律附 web/archive 真机截图。', importance: 5, topic: 'process', createdAt: iso(60) },
        { id: 'm2', text: '对比度门禁口径：正文 4.5:1，非文本图形 3:1。', importance: 4, topic: 'a11y', createdAt: iso(60 * 30) },
      ],
    },
    'memory.search': { count: 0, results: [] },
    // 形状与各面板的类型一致（错了会在渲染期抛错 → 错误边界卸载整棵树，后续截图全废）：
    //   profile.list → Profile[]、agents.list → 数组、plugins.list → PluginManifest[]。
    'profile.list': [
      { id: 'default', name: 'default', model: 'probe-large', plugins: ['probe-git'], createdAt: iso(600) },
      { id: 'review', name: 'review', model: 'probe-small', plugins: [], createdAt: iso(120) },
    ],
    'profile.active': { profileId: 'default', plugins: ['probe-git'] },
    'context.usage': {
      threadId: 'probe-t1',
      windowTokens: 200000,
      usedTokens: 78000,
      percent: 39,
      rows: [
        { label: '系统提示', tokens: 3200, percent: 4 },
        { label: '对话历史', tokens: 41000, percent: 53 },
        { label: '工具结果', tokens: 22400, percent: 29 },
        { label: '记忆召回', tokens: 8600, percent: 11 },
        { label: '附件', tokens: 2800, percent: 3 },
      ],
      mcpToolCount: 6,
      systemToolCount: 14,
      source: 'probe',
      cache: { hitRate: 0.62, calls: 96 },
      collectedAt: iso(1),
    },
    'quota.get': {
      plan: { id: 'pro', label: 'Pro', multiplier: 2, upgraded: true, fallback: false },
      dailyTokens: 2000000,
      effectiveTokens: 4000000,
      usedTokens: 508000,
      remainingPercent: 87,
      models: [],
      dayKey: '2026-06-06',
      resetAt: '2026-06-06T23:59:59.999Z',
      source: 'local-budget',
    },
  };
}

/**
 * 生成带覆盖数据的 stub 页：先挂 `window.__RPC_OVERRIDES__`，再走标准 stub 注入。
 * @returns {string} 完整 HTML 文本
 */
function stubHtmlWithProbeData() {
  const preload =
    '<script>window.__RPC_OVERRIDES__ = ' + JSON.stringify(probeResults()) + ';</script>\n';
  return stubHtmlCdp().replace('<div id="root"></div>', '<div id="root"></div>\n' + preload);
}

/** 造一段"真实形状"的对话流：user → reasoning → 工具簇（含失败）→ todo → assistant(markdown) → system。 */
function probeEvents() {
  const t = (n) => 1_780_000_000_000 + n * 1000;
  return [
    { id: 'p-user-1', type: 'user', timestamp: t(0), payload: { content: '把工作台的视觉层打磨一遍：字体、层级、焦点态，并把 emoji 图标换成自研线性图标。' } },
    { id: 'p-reason-1', type: 'reasoning', timestamp: t(1), payload: { content: '先看现有 CSS 的 token 有没有层级语义；再看组件的 class 契约有哪些被测试钉住，避免为了好看把契约改坏。' } },
    { id: 'p-tc-1', type: 'tool_call', timestamp: t(2), payload: { callId: 'pc-1', name: 'read_file', args: { path: 'web/styles/theme.css' } } },
    { id: 'p-tr-1', type: 'tool_result', timestamp: t(3), payload: { callId: 'pc-1', ok: true, text: '读取 93 行' } },
    { id: 'p-tc-2', type: 'tool_call', timestamp: t(4), payload: { callId: 'pc-2', name: 'shell', args: { cmd: 'npm run web:test' } } },
    { id: 'p-tr-2', type: 'tool_result', timestamp: t(5), payload: { callId: 'pc-2', ok: true, text: '# tests 318\n# pass 318\n# fail 0' } },
    { id: 'p-tc-3', type: 'tool_call', timestamp: t(6), payload: { callId: 'pc-3', name: 'apply_patch', args: { path: 'web/styles/polish.css' } } },
    { id: 'p-tr-3', type: 'tool_result', timestamp: t(7), payload: { callId: 'pc-3', ok: false, text: '✗ 目标行已被其它改动覆盖，补丁未应用' } },
    { id: 'p-todo-1', type: 'todo', timestamp: t(8), payload: { todos: [
      { status: 'completed', content: '抽出设计 token（层级 / 品牌 / 语义色）' },
      { status: 'in_progress', content: '把 emoji 图标替换为线性 SVG 图标集' },
      { status: 'pending', content: '两套主题各截一轮真机图复核' },
    ] } },
    { id: 'p-asst-1', type: 'assistant', timestamp: t(9), payload: { content: [
      '## 打磨完成',
      '',
      '改动集中在**视觉层**，不动任何 class 契约与交互：',
      '',
      '- 抽出 4 层表面 + 2 条描边的层级语言，卡片改发丝线、浮层才用阴影',
      '- 单一品牌强调色（`--brand`），只在"当前 / 可交互 / 焦点"三种语义上出现',
      '- 自研线性图标集替换全站 emoji：字形可控、跟随 `currentColor`',
      '',
      '| 项 | 前 | 后 |',
      '| --- | --- | --- |',
      '| 字体族 | 系统栈裸用 | 界面栈 + 机器产物等宽栈 |',
      '| 焦点环 | 单色描边 | 品牌色实环 + 外晕 |',
      '| 数字 | 比例数字 | tabular-nums 等宽数字 |',
      '',
      '```ts',
      "export const TOKENS = { surface: 4, hairline: 2, accent: 'brand' } as const;",
      '```',
      '',
      '> 验收口径：颜色门禁 4.5:1 全绿 + 318 例组件契约零回归 + 真机截图留档。',
    ].join('\n') } },
    { id: 'p-asst-2', type: 'assistant', timestamp: t(10), payload: { content: '补充：窄窗 640px 下左右栏切抽屉，中栏留白回收，气泡放宽到 94%。' } },
    { id: 'p-sys-1', type: 'system', timestamp: t(11), payload: { content: '探针夹具事件：以上内容用于视觉评审，不是真实会话记录。' } },
  ];
}

/** 解析 CLI 覆盖项（--name=a,b）。 */
function listArg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  if (!hit) return fallback;
  return hit.slice(name.length + 3).split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * 交互态清单：`key` 是文件名后缀，`open` 负责把界面推进到该状态并返回 true/false。
 *
 * 为什么必须有这一节：静态面板截图看不到"浮层压没压住内容、模态的层级对不对、命令面板的
 * 键盘通路通不通"——而这些恰是用户实际操作里最容易出观感问题的部分（z-index、浮层裁切、
 * 焦点环）。每个状态都从**重载后的干净页面**开始，互不污染。
 */
const STATES = [
  {
    key: 'streaming',
    // 流式中间态：**回合仍在飞**时推增量截图——这是回合流式缓冲（TurnStreamBuffer）唯一可见的出口，
    // 也是"改了节流 / 生命周期却只能靠单测保证"那条路径的真机判据。
    // 注意顺序：必须先推增量、**最后**才收尾（收尾后流式卡片按设计退场，推增量就什么都看不到了）。
    open: async (cdp) => {
      await cdp.push({ method: 'thread.text_delta', params: { text: '正在把增量' } });
      await cdp.push({ method: 'thread.text_delta', params: { text: '逐段拼进流式卡片……' } });
      const shown = await cdp.waitFor("!!document.querySelector('.streaming-assistant .content')", 600);
      await cdp.evaluate(
        "window.__RESOLVE_TURN__ && window.__RESOLVE_TURN__({ threadId:'probe-t1', finalText:'', steps:1 });",
      );
      return shown;
    },
  },
  {
    key: 'cmdk',
    open: async (cdp) => {
      await cdp.press('k', { modifiers: 2 }); // Ctrl+K
      return cdp.evaluate("!!document.querySelector('.cmdk')");
    },
  },
  {
    key: 'dropdown',
    open: async (cdp) => {
      await cdp.click('.dd');
      return cdp.evaluate("!!document.querySelector('.dd-menu')");
    },
  },
  {
    key: 'addmenu',
    open: async (cdp) => {
      await cdp.click('.addmenu-ico');
      return cdp.evaluate("!!document.querySelector('.addmenu-pop')");
    },
  },
  {
    key: 'capacity',
    open: async (cdp) => {
      await cdp.click('.cap');
      return cdp.evaluate("!!document.querySelector('.cap-pop')");
    },
  },
  {
    key: 'permission',
    open: async (cdp) => {
      await cdp.click('.dd.perm');
      return cdp.evaluate("!!document.querySelector('.dd-menu.wide')");
    },
  },
  {
    key: 'approval',
    open: async (cdp) => {
      await cdp.push({
        method: 'approval.request',
        params: { requestId: 'probe-r1', toolName: 'shell', target: 'rm -rf ./build', args: { cmd: 'rm -rf ./build' } },
      });
      return cdp.waitFor("!!document.querySelector('.overlay.show .modal[role=\"dialog\"]')", 400);
    },
  },
  {
    key: 'picker',
    open: async (cdp) => {
      // 入口在**工作区下拉菜单里**（不是常驻按钮）：先开菜单，再点「+ 添加项目」。
      await cdp.click('.ws-switch-btn');
      const opened = await cdp.waitFor("!!document.querySelector('.ws-switch-menu .ws-add')", 400);
      if (!opened) return false;
      await cdp.click('.ws-switch-menu .ws-add');
      const modal = await cdp.waitFor("!!document.querySelector('.fp-overlay .fp-modal')", 600);
      // 失败时把现场打出来：走不通的是"合成点击的通路"还是"真实渲染"，靠症状猜不出来。
      if (!modal) {
        const why = await cdp.evaluate(`(function(){
          return {
            overlay: document.querySelectorAll('.fp-overlay').length,
            menu: document.querySelectorAll('.ws-switch-menu').length,
            addBtn: document.querySelectorAll('.ws-add').length,
            crash: !!document.querySelector('.crash-panel'),
          };
        })()`);
        emit({ kind: 'state-debug', state: 'picker', why });
      }
      return modal;
    },
  },
  {
    key: 'graph-run',
    // 编排**运行态**（`graph-runs`）：静态面板图只能看到编辑器，看不到"节点跑起来"的观感
    // （running 呼吸圈 / done / failed 三态芯片）。走"载入示例 → 运行"这条用户真会走的通路。
    open: async (cdp) => {
      const clicked = await openPaneByLabel(cdp, '编排');
      if (!clicked) return false;
      // 按**可见文本**点击（位置式选择器在壳层重构后必然失配：`.pm-head .ghost:nth-child(2)`
      // 与 `.row button.send:last-child` 都依赖元素顺序，改一次布局就静默点错/点空）。
      const clickText = async (label, sel) =>
        (await cdp.evaluate(
          `(function(){ var b=[].slice.call(document.querySelectorAll(${JSON.stringify(sel)})).filter(function(x){ return x.textContent.trim()===${JSON.stringify(label)}; })[0]; if(!b) return false; b.click(); return true; })()`,
        )) === true;
      if (!(await clickText('载入示例', 'button'))) {
        emit({ kind: 'graph-run-step', step: '载入示例', ok: false });
        return false;
      }
      await new Promise((r) => setTimeout(r, 200));
      if (!(await clickText('运行', 'button'))) {
        emit({ kind: 'graph-run-step', step: '运行', ok: false });
        return false;
      }
      // 运行态卡片由 SSE 的 graph.progress 汇总注入。**载荷形状必须是服务端真实形状**：
      // 逐节点 `{ runId, id, status, … }`（`AppReducers.applyGraphProgress` 读 `p.id`）。
      // 这里曾推过一批 `{ runId, defName, nodes:[…] }`——`p.id` 为 undefined ⇒ 芯片带 undefined 状态，
      // `.graph-node` 照样存在（断言通过），但「节点跑起来」这条其实一点没被验到（假绿）。
      // 先等运行卡片出现（onRunStart 写状态），否则推来的进度无处落账。
      if (!(await cdp.waitFor("!!document.querySelector('#graphStatus .graph-card')", 500))) {
        emit({ kind: 'graph-run-step', step: '运行卡片', ok: false });
        return false;
      }
      for (const node of [
        { id: 'plan', status: 'done' },
        { id: 'a', status: 'done' },
        { id: 'b', status: 'running' },
        { id: 'merge', status: 'pending' },
      ]) {
        await cdp.push({ method: 'graph.progress', params: { runId: 'probe-run-1', ...node } });
      }
      // 断言必须是「真实状态类被渲染」：只看 `.graph-node` 存在的话，上面那种假绿又会通过。
      if (
        !(await cdp.waitFor(
          "!!document.querySelector('.graph-node.running') && !!document.querySelector('.graph-node.done')",
          500,
        ))
      ) {
        emit({
          kind: 'graph-run-step',
          step: '节点状态',
          ok: false,
          chips: await cdp.evaluate(
            "[].slice.call(document.querySelectorAll('.graph-node')).map(function(x){return x.className;})",
          ),
        });
        return false;
      }
      // 失败收尾 ⇒ 卡片转「存在失败步骤」并出现**续跑入口**（这是 2026-10-08 新增的用户面能力）。
      await cdp.push({ method: 'graph.done', params: { runId: 'probe-run-1', ok: false, blackboard: {} } });
      if (!(await cdp.waitFor("!!document.querySelector('.btn-resume')", 500))) {
        emit({ kind: 'graph-run-step', step: '续跑按钮', ok: false });
        return false;
      }
      // 点续跑：走 graph.resume → onRunStart 复位 ⇒ 卡片回到「运行中…」且按钮消失。
      const btnThere = await cdp.evaluate("!!document.querySelector('.btn-resume')");
      await cdp.click('.btn-resume');
      const reset = await cdp.waitFor(
        "(function(){var b=document.querySelector('.btn-resume');var f=document.querySelector('#graphStatus .saved');return !b && !!f && /运行中/.test(f.textContent||'');})()",
        800,
      );
      if (!reset) {
        emit({
          kind: 'graph-run-step',
          step: '续跑复位',
          ok: false,
          btnThere,
          btnStill: await cdp.evaluate("!!document.querySelector('.btn-resume')"),
          foot: await cdp.evaluate(
            "(function(){var f=document.querySelector('#graphStatus .saved');return f?f.textContent:null;})()",
          ),
          toasts: await cdp.evaluate(
            "[].slice.call(document.querySelectorAll('.toast,.toast-item,.toast-msg')).map(function(x){return x.textContent.trim();})",
          ),
        });
      }
      return reset;
    },
  },
  {
    key: 'review-help',
    open: async (cdp) => {
      // 「变更（评审）」面板**只有右栏标签条能进**：`TABS` 有它、`NavRail` 的 9 项里没有
      // （桌面端 rail 是主入口，故该面板在 ≥881px 只能靠 hash 路由激活）。
      // 状态截图本来就要能直达，故走路由：`#pane=changes`。这条路径与用户点标签条等价。
      await cdp.evaluate("location.hash = '#pane=changes'");
      const ready = await cdp.waitFor("!!document.querySelector('.review-root')", 600);
      if (!ready) return false;
      await cdp.click('.rh-toggle');
      const help = await cdp.waitFor("!!document.querySelector('.review-help')", 400);
      if (!help) {
        const why = await cdp.evaluate(`(function(){
          return {
            root: !!document.querySelector('.review-root'),
            toggle: !!document.querySelector('.rh-toggle'),
            help: !!document.querySelector('.review-help'),
          };
        })()`);
        emit({ kind: 'state-debug', state: 'review-help', why });
      }
      return help;
    },
  },
];

/** 面板清单：[面板标签, 文件名后缀]。 */
const PANES = [
  ['工具', 'tools'],
  ['指标', 'metrics'],
  ['设置', 'settings'],
  ['插件', 'plugins'],
  ['编排', 'graph'],
  ['记忆', 'memory'],
  ['配置集', 'profiles'],
  ['钻取', 'detail'],
  ['回滚', 'rollback'],
];

/**
 * 通过**现役**入口打开一个面板：桌面端的唯一常驻入口是 `PanelPicker` 菜单
 * （原 `NavRail` 竖条已随壳层重构移除，`.rail-btn` 不再存在——2026-10-08 实测：
 * 探针仍点 `.rail-btn` ⇒ 全部面板图与依赖面板的交互态一起报「未找到面板按钮」，属**假红**）。
 * @param cdp CDP 会话
 * @param label 面板标签（如「编排」）
 * @returns 是否成功打开
 */
async function openPaneByLabel(cdp, label) {
  // 先等入口按钮出现（重载后挂载有先后，直接点会点空 ⇒ 假红）。
  if (!(await cdp.waitFor("!!document.querySelector('.pp-btn')", 1500))) return false;
  /**
   * 走一遍「展开菜单 → 按标签点项」。
   * 注意：只有菜单**未展开**时才点按钮——已展开时再点会收起，随后就找不到菜单项了（首帧竞态）。
   * @returns 是否成功选中该面板
   */
  const pickOnce = async () => {
    await cdp.evaluate(
      "(function(){ var b=document.querySelector('.pp-btn'); if(b && b.getAttribute('aria-expanded')!=='true') b.click(); return true; })()",
    );
    // 菜单是点击后挂载的：等它真的出现（固定的 150ms 在某些主题/首帧下不够）。
    if (!(await cdp.waitFor("!!document.querySelector('.pp-menu .pp-item')", 800))) return false;
    return (
      (await cdp.evaluate(
        `(function(){ var hit=[].slice.call(document.querySelectorAll('.pp-item')).filter(function(x){ var l=x.querySelector('.pp-label'); return !!l && l.textContent.trim()===${JSON.stringify(label)}; })[0]; if(!hit) return false; hit.click(); return true; })()`,
      )) === true
    );
  };
  if (await pickOnce()) return true;
  // 一次重试：首帧竞态下偶发失败（2026-10-08 全量跑测实测 dark/graph 一次），重试即稳。
  await new Promise((r) => setTimeout(r, 150));
  return pickOnce();
}

/**
 * 把页面推进到"有会话 + 有事件流"的渲染态（与 virtualProbe 同源的操作序列）。
 * @param cdp CDP 会话
 * @param opts.keepTurnInFlight 为 true 时**不**收尾回合（留给调用方自己收）——
 *   流式中间态必须在回合仍在飞时观察，收尾后流式卡片按设计退场。
 * @returns 无
 */
async function seedSession(cdp, opts = {}) {
  await cdp.evaluate(
    "(function(){ var ta=document.querySelector('.composer-input textarea'); var b=document.querySelector('button.send'); if(ta&&b){ ta.value='打磨工作台视觉层'; b.dispatchEvent(new Event('input',{bubbles:true})); b.click(); } })()",
  );
  await cdp.waitFor('!!window.__RESOLVE_TURN__', 800);
  if (opts.keepTurnInFlight !== true) {
    await cdp.evaluate("window.__RESOLVE_TURN__ && window.__RESOLVE_TURN__({ threadId:'probe-t1', finalText:'', steps:1 });");
  }
  for (const ev of probeEvents()) {
    await cdp.push({ method: 'thread.event', params: { event: ev } });
  }
  await cdp.waitFor("document.querySelectorAll('.ev').length > 4", 800);
}

async function main() {
  if (!existsSync(ARCHIVE)) mkdirSync(ARCHIVE, { recursive: true });
  const browser = findBrowser();
  if (!browser) {
    process.stdout.write('SKIP: browser not found\n');
    return 0;
  }
  if (typeof globalThis.WebSocket !== 'function') {
    process.stdout.write('SKIP: Node 缺全局 WebSocket（需 Node >= 22）\n');
    return 0;
  }
  const wantPanes = listArg('panes', PANES.map((p) => p[1]));
  const wantThemes = listArg('themes', ['dark', 'light']);
  const widths = listArg('widths', ['1280', '640']).map(Number);
  // 交互态默认**也**跑（它们在静态截图里是盲区）；用 --no-states 关掉以便快速只看面板。
  const wantStates = !process.argv.includes('--no-states');
  const externalWs = process.env.OMNI_PROBE_WS || '';
  const server = await serveStatic(WEB_ROOT_PATH, { [`/${STUB_NAME}`]: stubHtmlWithProbeData() });
  const userDataDir = mkdtempSync(join(tmpdir(), 'omni-visual-ud-'));
  const stamp = Date.now();
  const shots = [];
  const failures = [];
  let cdp;
  let proc;
  try {
    let wsUrl = externalWs;
    if (!wsUrl) {
      const port = await getFreePort();
      const url = `http://127.0.0.1:${server.port}/${STUB_NAME}`;
      try {
        proc = launchChromeForCdp(browser, url, userDataDir, port);
      } catch (err) {
        if (!/EPERM/.test(String(err && err.message))) throw err;
        emit({ kind: 'launch-fallback', reason: 'spawn EPERM', used: 'launchChromeNoPipe' });
        proc = launchChromeNoPipe(browser, url, userDataDir, port);
      }
      try {
        proc.on('error', () => {});
        wsUrl = await waitForPageWs(port, STUB_NAME, Number(process.env.OMNI_PROBE_WAIT_MS || 12000));
      } catch (err) {
        emit({ kind: 'error', message: '无法启动浏览器：' + String((err && err.message) || err) });
        return 0;
      }
    }
    cdp = new CdpSession(wsUrl);
    if (!(await cdp.waitMounted(1200))) throw new Error('app 未挂载');

    // 布局体检（--measure）：打印关键元素的实测几何。视觉问题里"看起来空/被压扁/被裁掉"
    // 十之八九是尺寸问题，而尺寸只有真浏览器量得准——截图能看出"不对"，量一下才知道"为什么"。
    if (process.argv.includes('--measure')) {
      await seedSession(cdp);
      const geo = await cdp.evaluate(`(function(){
        var pick = function(sel){
          var el = document.querySelector(sel);
          if (!el) return null;
          var r = el.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
        };
        return {
          // 壳层重构后左栏竖条（.rail / .rail-btn / .rail-icon）已不存在，那几项**恒为 null**，
          // 属于死数据（2026-10-08 清理）。现役的图标按钮是面板入口 .pp-btn——几何体检就量它，
          // 它同样是「svg 作为 flex 子项被压扁」这类老问题的观测点。
          panelPicker: pick('.pp-btn'),
          panelPickerSvg: pick('.pp-btn svg'),
          panelPickerSvgAttr: (function(){ var s=document.querySelector('.pp-btn svg'); return s ? { w: s.getAttribute('width'), h: s.getAttribute('height'), vb: s.getAttribute('viewBox'), paths: s.querySelectorAll('path,line,circle').length, stroke: getComputedStyle(s).stroke, sw: getComputedStyle(s).strokeWidth, display: getComputedStyle(s).display, flex: getComputedStyle(s).flex, cssW: getComputedStyle(s).width } : null; })(),
          left: pick('.col.left'), center: pick('.center'), stream: pick('.stream'),
          streamInner: pick('.stream-inner'), card: pick('.ev.assistant .card'),
          userCard: pick('.ev.user .card'), composer: pick('.composer'),
          right: pick('.col.right'), send: pick('button.send'),
          iconbtnAttach: pick('.iconbtn.attach'), ddIcoSvg: pick('.dd-ico svg')
        };
      })()`);
      emit({ kind: 'measure', geo });
      return 0;
    }

    for (const theme of wantThemes) {
      for (const width of widths) {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width,
          height: HEIGHT,
          deviceScaleFactor: 1,
          mobile: false,
        });
        // 每张图都重开一页：面板崩溃不会污染后续截图（见文件头说明）。
        const panes = width === widths[0] ? [['', 'stream'], ...PANES] : [['', 'stream']];
        for (const [label, key] of panes) {
          if (key !== 'stream' && !wantPanes.includes(key)) continue;
          await cdp.send('Page.enable');
          await cdp.send('Page.reload', { ignoreCache: true });
          if (!(await cdp.waitMounted(2400))) {
            failures.push(`${theme}/${key}: 重载后未挂载`);
            continue;
          }
          await seedSession(cdp);
          await cdp.evaluate(`document.documentElement.setAttribute('data-theme','${theme}')`);
          if (label) {
            const clicked = await openPaneByLabel(cdp, label);
            if (!clicked) {
              failures.push(`${theme}/${key}: 打开面板失败 ${label}`);
              continue;
            }
          } else {
            // 对话主体图：滚到出现工具簇的位置（首屏更有信息量）。
            await cdp.evaluate(
              "(function(){ var s=document.querySelector('.stream'); if(s){ s.scrollTop = Math.max(0, s.scrollHeight*0.42); s.dispatchEvent(new Event('scroll')); } })()",
            );
          }
          await new Promise((r) => setTimeout(r, 180));
          const crash = await cdp.evaluate(
            "!!document.querySelector('.crash-panel') ? document.querySelector('.crash-title') ? document.querySelector('.crash-msg').textContent : 'crash' : ''",
          );
          if (crash) failures.push(`${theme}/${key}: 渲染崩溃 → ${String(crash).slice(0, 120)}`);
          shots.push(
            await cdp.screenshot(join(ARCHIVE, `polish-${theme}-${key}-${width}-${stamp}.png`)),
          );
        }

        // 交互态（浮层 / 模态 / 键盘通路）：这些恰恰是只截"静态页面"永远看不到的部分，
        // 而它们占用户实际互动的大头。只在第一个宽度截，避免图量爆炸。
        if (width === widths[0] && wantStates) {
          for (const st of STATES) {
            await cdp.send('Page.enable');
            await cdp.send('Page.reload', { ignoreCache: true });
            if (!(await cdp.waitMounted(2400))) {
              failures.push(`${theme}/${st.key}: 重载后未挂载`);
              continue;
            }
            await seedSession(cdp, { keepTurnInFlight: st.key === 'streaming' });
            await cdp.evaluate(`document.documentElement.setAttribute('data-theme','${theme}')`);
            const opened = await st.open(cdp);
            if (opened !== true) {
              failures.push(`${theme}/${st.key}: 未能进入该状态`);
              continue;
            }
            await new Promise((r) => setTimeout(r, 220));
            const crash = await cdp.evaluate(
              "!!document.querySelector('.crash-panel') ? document.querySelector('.crash-msg').textContent : ''",
            );
            if (crash) failures.push(`${theme}/${st.key}: 渲染崩溃 → ${String(crash).slice(0, 120)}`);
            shots.push(
              await cdp.screenshot(join(ARCHIVE, `polish-${theme}-state-${st.key}-${stamp}.png`)),
            );
          }
        }
      }
    }
    emit({ kind: 'screenshots', count: shots.length, bytes: shots.reduce((a, b) => a + b, 0), stamp });
    // 控制台 / 网络诊断：视觉缺陷常常先在控制台留痕（模块 404、渲染告警、被拒的请求）。
    // 只在最后汇报，不阻断——本探针是探针而非门禁。
    const diag = cdp.diagnostics();
    const failed = diag.failedRequests.filter((f) => !/ERR_ABORTED/.test(String(f.status)));
    if (diag.exceptions.length || failed.length || diag.console.length) {
      emit({
        kind: 'diagnostics',
        exceptions: diag.exceptions.slice(0, 5),
        failedRequests: failed.slice(0, 5),
        console: diag.console.slice(0, 8),
      });
    }
    if (failures.length) emit({ kind: 'warn', failures });
  } catch (err) {
    emit({ kind: 'error', message: String((err && err.message) || err) });
  } finally {
    if (cdp) cdp.close();
    killChromeTree(proc, userDataDir);
    await server.close();
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* Chrome 退出瞬时仍可能持锁，交由 OS 回收 */
    }
  }
  return 0;
}

process.exitCode = await main();
