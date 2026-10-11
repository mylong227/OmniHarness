// 架构约束门禁（P0.4，docs/REFACTOR_BOARD_2026-09-12.md §P0.4）。
//
// 职责：把「架构约束」从人工评审变为机械可证，覆盖三类六边形/端口-适配器铁律：
//   1. 禁 core→adapters：core 层（src/core）不得 import adapters 层（src/adapters）。
//      —— 这是端口-适配器的最硬规则：core 只依赖 ports，依赖方向必须向内。
//   2. 禁 adapters→core：adapter 不得 import core 的具体实现（只允许依赖 ports）。
//   3. ports 纯度：src/ports 下文件只声明接口/类型/错误类型，不得出现 class 实现、
//      不得 import 第三方裸模块（node: 内置与相对导入除外）。
//   4. 目录平铺告警：单目录直接 .ts 文件数 > 30 即告警（非阻断，提示按域拆分）。
//
// 冻结-递减策略（docs §5.6）：当前存量违规全部列入白名单，门禁只拦「白名单之外的新增违规」，
// 存量按 P1/P3 批次清偿并从白名单移除。移除一条 → 门禁可视违规数递减，直至白名单清空升为全阻断。
//
// 退出码：发现「新增（非白名单）」违规 → 1（阻断）；否则 0（即使存在白名单内存量也放行，
// 便于立刻接入 pre-commit / CI 而不破坏现有树）。--strict 下白名单内存量也阻断（用于白名单清空后）。
//
// 无第三方依赖：仅用 node:fs / node:path / typescript（已为 devDependency）。
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = 'src';
const STRICT = process.argv.includes('--strict');

// ---- 1. 收集 src 下所有 .ts ----
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (['tests', 'node_modules', 'dist'].includes(e.name)) continue;
      walk(p);
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) files.push(p);
  }
})(root);

const key = (f) =>
  f
    .split(path.sep)
    .join('/')
    .replace(/^src\//, '')
    .replace(/\.ts$/, '');

// ---- 2. 解析相对 import 边（from → to 模块 key） ----
const edges = []; // { from, to }
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const re = /(?:from\s+|import\s*\(\s*)(['"])([^'"]+)\1/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[2];
    if (!spec.startsWith('.')) continue;
    const to = path.posix
      .normalize(path.posix.join(path.posix.dirname(key(f)), spec))
      .replace(/\.js$/, '')
      .replace(/\/index$/, '');
    edges.push({ from: key(f), to });
  }
}

// ---- 3. 白名单（冻结存量；P1/P3 清偿后从此移除对应条目） ----
// core→adapters（0 条，docs §1.3；runtime 簇 4 条 + turnRunner 1 条 + sandbox 簇 2 条 已 P1 解耦清零，存量归零）
const CORE_TO_ADAPTERS_WL = new Set([]);
// adapters→core（0 条，docs §1.3；runGoalTool→agent 经 AgentFactoryPort 端口注入清零，P1 全部归零）
const ADAPTERS_TO_CORE_WL = new Set([]);
// ports 纯度：存量已清零（P1.3 完成——`ports/model.ts` 的 2 个错误类迁至 `src/errors/**`，
// 原路径仅保留 `export ... from` 再导出，公共 API 面不变）。
// 空集合 = 「新增即红」：此后 src/ports/** 出现任何 class 声明都会阻断提交。
const PORTS_CLASS_WL = new Set([]);
// ports→实现层：**新增规则（2026-09-22）**，2026-10-11 把覆盖补全（原只认 6 个硬编码前缀）。
// 为什么需要：原三条规则只覆盖 core↔adapters 与 ports 的「第三方裸导入 / class 声明」，
// 于是 `ports/runtime/agent.ts` 曾长期 `import type { OmniHarnessRuntime } from '…/core/runtime.js'`
// ——端口契约被绑死在 core 具体类型上，而门禁「看不见」。
//
// 存量白名单：本规则原先只枚举 6 个层（core/adapters/config/composition/context/search），
// `spark/ skill/ security/ server/ evolution/ subagent/ mcp/ worker/ native/ a2a/ plugin/` 等层的
// ports→实现层 边**完全不可见**（2026-10-06 自述的边界）。2026-10-11 动态全枚举后，这些存量边
// 首次现形：**一次性登记在此（冻结-递减），按批递减**。它们全是 `import type` 的类型契约
// （类型住在实现文件里，正确修法是把类型搬进 `ports/**`，即 G25/G25-b 那一套，属独立一片）。
const PORTS_IMPL_WL = new Set([
  // 组合根契约：运行时/配置的端口文件反向引用实现类型。
  'ports/composition/omniHarnessRuntime->native/nativeBackend',
  'ports/composition/omniHarnessRuntime->spark/sparkController',
  'ports/composition/omniHarnessRuntime->a2a/a2aProtocol',
  'ports/config/omniHarnessConfig->worker/workerRegistry',
  'ports/config/omniHarnessConfig->security/toolOutputTrust',
  'ports/config/omniHarnessConfig->skill/skill',
  'ports/config/resolvedConfig->spark/sparkController',
  'ports/config/resolvedConfig->skill/skillRegistry',
  'ports/config/subagentPortSeed->subagent/subagentTypes',
  // 工具/协议契约。
  'ports/mcp/mcpServerOptions->server/transport/lineTransport',
  'ports/mcp/mcpServerOptions->mcp/mcpProtocol',
  'ports/plugin/plugin->plugin/pluginApplyContext',
  // 演化/技能契约（ADR-0008 一族）。
  'ports/runtime/evolution/candidate->skill/skill',
  'ports/runtime/evolution/evolutionControllerOptions->evolution/rlvrLoop',
  'ports/runtime/evolution/promotionLedger->skill/skill',
  'ports/runtime/skill->skill/skill',
  'ports/runtime/skillEdit/crisprEditSpec->skill/skill',
  // 安全/监督契约。
  'ports/runtime/sandbox/networkEgressOptions->security/ssrfPolicy',
  'ports/runtime/supervisor/auditSinkLike->server/services/auditSink',
  'ports/security/ssrfOptions->security/ssrfPolicy',
  'ports/subagent/subagentPortsShape->native/nativeBackend',
]);

/**
 * **基础层**：`ports/**` 允许依赖的共享底座（错误类型、通用工具）。
 *
 * 为什么要有这一档：动态全枚举若把 `errors/` `util/` 也当实现层，会立刻产生 5 条"违规"，
 * 而它们不是违规——`ports/model/model.ts` 再导出 `ModelCallError`、`ports/memory/**` 用
 * `util/eigenspectrum`（本板已认定它是**共享数学基础设施**，不是某条实现路径的私有物）。
 * 把"允许"显式写出来，比靠硬编码 6 个前缀来**意外允许**它更诚实。
 */
const FOUNDATION_LAYERS = ['errors/', 'util/'];

/**
 * 本规则认定的「实现层」= `src/` 下**除 `ports/` 与基础层之外的全部顶层目录**（**动态枚举**，2026-10-11 改）。
 *
 * 为什么从静态枚举改成动态（原实现的能力边界它自己已自述）：原先硬编码 6 个前缀，于是上面
 * 白名单里那些层的 ports→实现层 边**完全不可见**，且**将来新增目录也不会自动纳入**——
 * 一条「端口只依赖契约」的铁律，实际只覆盖了 6 个层，而日志标签只列 3 个前缀，读起来像"已全覆盖"。
 * 动态枚举把覆盖补全：新目录**自动纳入**（新增即红），不再依赖有人记得改脚本。
 *
 * 与 `--strict` 的关系：白名单内 21 条存量边**不**参与 `--strict` 的"白名单必须为空"断言
 * （同依赖环的先例：环的阻断由"新增"承担）——否则本规则要么无法开全枚举、要么 CI 恒红。
 */
const IMPL_LAYERS = fs
  .readdirSync(root, { withFileTypes: true })
  .filter(
    (e) =>
      e.isDirectory() &&
      !['ports', ...FOUNDATION_LAYERS.map((l) => l.replace(/\/$/, ''))].includes(e.name),
  )
  .map((e) => `${e.name}/`)
  .sort();
if (IMPL_LAYERS.length === 0) {
  // 空枚举 = 规则空转（本仓"0 项=通过"的同一形态）⇒ 显式失败，绝不静默通过。
  console.error('❌ 架构门禁失败：实现层枚举为空（src/ 目录结构异常）⇒ ports→实现层规则无从判定。');
  process.exit(1);
}

// ---- 4. 判定 ----
const caViolations = [];
const acViolations = [];
const portsImplViolations = [];
for (const { from, to } of edges) {
  const id = `${from}->${to}`;
  if (from.startsWith('core/') && to.startsWith('adapters/')) {
    caViolations.push({ id, whitelisted: CORE_TO_ADAPTERS_WL.has(id) });
  } else if (from.startsWith('adapters/') && to.startsWith('core/')) {
    acViolations.push({ id, whitelisted: ADAPTERS_TO_CORE_WL.has(id) });
  } else if (from.startsWith('ports/') && IMPL_LAYERS.some((layer) => to.startsWith(layer))) {
    portsImplViolations.push({ id, whitelisted: PORTS_IMPL_WL.has(id) });
  }
}

// ---- 4.5 依赖环（新增规则，2026-09-29） ----
// 为什么需要：上面三条只拦「跨层直连」，拦不住「同层/跨域互引成环」。实测存量 5 组环（41 个模块）,
// 成因全部是**接口定义散落在实现文件里**——A 为了用 B 的 `interface` 而 import B，B 又反向依赖 A。
// 把接口抽到基础层（src/ports/**，一接口一文件）即可断环；本规则负责「不许再新增环」。
//
// 白名单口径 = **成员集合**，不是「整组完全相等」：环缩小 = 重构有进展 ⇒ 放行；
// 一旦环里出现白名单之外的模块 ⇒ 判新增环，阻断。这样白名单只减不增，天然配合「冻结-递减」。
// 注：环的**存量**不计入 `--strict`（CI 跑的就是 `--strict`，纳入即红）；清偿至 0 组后随白名单清空一并纳入。
const CYCLE_WL_MEMBERS = new Set([
  // 环① CLI 旗标表组（4）：cliFlagTable ↔ cliHelp ↔ cliEnums ↔ argParser 互相取类型。
  'cli/argParser',
  'cli/cliEnums',
  'cli/cliFlagTable',
  'cli/cliHelp',
  // 环② 配置校验器组（8）：configFile 与 5 个 validator + providerPresets + configError 互引。
  'config/configError',
  'config/configFile',
  'config/mediaConfigValidator',
  'config/permissionConfigValidator',
  'config/profileLoader',
  'config/providerPresetValidator',
  'config/providerPresets',
  'config/ssrfPolicyValidator',
  // 环③ 上下文检索组（3）：contextEngine ↔ fileRerankIndex ↔ fileReranker。
  'context/contextEngine',
  'context/fileRerankIndex',
  'context/fileReranker',
  // 环④ 进化回放组（2）：rlvrLoop ↔ inMemoryReplayBuffer。
  'evolution/inMemoryReplayBuffer',
  'evolution/rlvrLoop',
  // 环⑤ Spark 桥组（4）：sparkController 与引擎集 / 遥测 / genesis 桥互引。
  'genesis/genesisSparkBridge',
  'spark/sparkController',
  'spark/sparkCycleTelemetry',
  'spark/sparkEngineSet',
  // 环⑥（2026-10-03 第十二轮 G25 **已拆解**）：原为 20 成员的「装配-运行时大环」，
  // 成因之一是「类型已在 src/ports/**、却绕道实现文件导入」——34 处导入改为直连 ports 后该环消失。
  // 其残留的 4 成员配置子环（configBuilder ↔ configFactory ↔ configToolRegistry/corePortsAssembler）
  // 也已于 **G25-b** 拆解：把 `SubagentPortSeed`（引用了 `MediaStack`）从 `configFactory.ts` 搬到
  // `src/ports/config/subagentPortSeed.ts`、`MediaStack` 搬到 `src/ports/media/mediaStack.ts`，
  // 于是 configBuilder / configToolRegistry 不再反向 import configFactory ⇒ 依赖方向恢复单向。
  // 环组数实测 6 → 5；本白名单随之**收紧**（删掉这 4 个成员），不留陈旧豁免。
]);

/** Tarjan 强连通分量：返回全部「真环」（size>1，或 size==1 且自环）。 */
function findCycleGroups(adjacency) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const groups = [];
  let counter = 0;
  const strong = (v) => {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adjacency.get(v) ?? []) {
      if (!adjacency.has(w)) continue;
      if (!index.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }
    if (low.get(v) !== index.get(v)) return;
    const group = [];
    for (;;) {
      const w = stack.pop();
      onStack.delete(w);
      group.push(w);
      if (w === v) break;
    }
    groups.push(group);
  };
  for (const v of adjacency.keys()) if (!index.has(v)) strong(v);
  return groups
    .filter((g) => g.length > 1 || (adjacency.get(g[0]) ?? new Set()).has(g[0]))
    .map((g) => g.slice().sort());
}

const adjacency = new Map();
for (const { from, to } of edges) {
  if (from === to) continue;
  if (!adjacency.has(from)) adjacency.set(from, new Set());
  adjacency.get(from).add(to);
}
const cycleViolations = findCycleGroups(adjacency).map((g) => ({
  id: g.join(' | '),
  size: g.length,
  whitelisted: g.every((m) => CYCLE_WL_MEMBERS.has(m)),
}));

const portsClassViolations = [];
for (const f of files) {
  const fk = f.split(path.sep).join('/');
  if (!fk.startsWith('src/ports/')) continue;
  const fileWl = PORTS_CLASS_WL.has(fk);
  const text = fs.readFileSync(f, 'utf8');
  // 第三方裸导入（node: 内置除外）
  const importRe = /(?:from\s+|import\s*\(\s*)(['"])([^'"]+)\1/g;
  let im;
  while ((im = importRe.exec(text))) {
    const spec = im[2];
    if (!spec.startsWith('.') && !spec.startsWith('node:')) {
      portsClassViolations.push({ id: `${fk}  import  ${spec}`, whitelisted: false });
    }
  }
  // class 声明（端口只应是接口/类型，不应有实现类）
  // 2026-09-26 修假信号：判据原为「对**原始文本**跑正则」，于是**注释里提到** `class X`（例如记录
  // 「实现类已迁出 ports」）也会被判成实现类——门禁自身的假阳性。现先剥掉块注释与行注释再匹配。
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const classRe = /\bclass\s+[A-Za-z0-9_]+/g;
  let cm;
  while ((cm = classRe.exec(code))) {
    portsClassViolations.push({ id: `${fk}  ::  ${cm[0]}`, whitelisted: fileWl });
  }
}

// 目录平铺告警（单目录直接 .ts > 30）
const dirCounts = new Map();
for (const f of files) {
  const d = path.dirname(f);
  dirCounts.set(d, (dirCounts.get(d) || 0) + 1);
}
const dirWarnings = [...dirCounts.entries()].filter(([, c]) => c > 30).sort((a, b) => b[1] - a[1]);

// ---- 5. 汇总输出 ----
const fmt = (v) => (v.whitelisted ? '  [WHITELISTED] ' : '  [NEW!]       ');
const newCount =
  caViolations.filter((v) => !v.whitelisted).length +
  acViolations.filter((v) => !v.whitelisted).length +
  portsClassViolations.filter((v) => !v.whitelisted).length +
  portsImplViolations.filter((v) => !v.whitelisted).length +
  cycleViolations.filter((v) => !v.whitelisted).length;

console.log('=== ARCHITECTURE GATE (P0.4) ===');
console.log(
  `\n[1] core→adapters 违规（${caViolations.length} 条，白名单 ${CORE_TO_ADAPTERS_WL.size}）：`,
);
caViolations.forEach((v) => console.log(fmt(v) + v.id));
console.log(
  `\n[2] adapters→core 违规（${acViolations.length} 条，白名单 ${ADAPTERS_TO_CORE_WL.size}）：`,
);
acViolations.forEach((v) => console.log(fmt(v) + v.id));
console.log(`\n[3] ports 纯度（第三方裸导入 / class 实现，白名单文件 ${PORTS_CLASS_WL.size}）：`);
if (portsClassViolations.length === 0) console.log('  (无)');
else portsClassViolations.forEach((v) => console.log(fmt(v) + v.id));
console.log(
  `\n[3.5] ports→实现层（动态全枚举，基础层 errors/util 除外；${String(IMPL_LAYERS.length)} 个层；白名单 ${PORTS_IMPL_WL.size}）——端口只依赖契约：`,
);
if (portsImplViolations.length === 0) console.log('  (无)');
else portsImplViolations.forEach((v) => console.log(fmt(v) + v.id));
// 存量债务按层计数：白名单不参与 --strict，但**必须看得见**——否则"白名单里有交代"会掩盖
// "某个层的 ports 契约正在持续腐化"（本仓对这种"有登记、看不见"的形态很警惕）。
if (portsImplViolations.length > 0) {
  const byLayer = new Map();
  for (const v of portsImplViolations) {
    const layer = v.id.split('->')[1]?.split('/')[0] ?? '(未知)';
    byLayer.set(layer, (byLayer.get(layer) ?? 0) + 1);
  }
  const rows = [...byLayer.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([layer, n]) => `${layer}×${n}`)
    .join(' ');
  console.log(`  存量债务按目标层：${rows}`);
}
console.log(
  `\n[5] 依赖环（Tarjan SCC，白名单成员 ${CYCLE_WL_MEMBERS.size}）——新增环即红，环缩小放行：`,
);
if (cycleViolations.length === 0) console.log('  (无)');
else cycleViolations.forEach((v) => console.log(`${fmt(v)}[${v.size} 成员] ${v.id}`));
console.log(`\n[4] 目录平铺告警（直接 .ts > 30，非阻断）：`);
if (dirWarnings.length === 0) console.log('  (无)');
else
  dirWarnings.forEach(([d, c]) =>
    console.log(`  ${c} 文件  ${d.split(path.sep).join('/')}/  （建议按域拆分）`),
  );

const depTotal = caViolations.length + acViolations.length;
const depWl =
  depTotal -
  caViolations.filter((v) => !v.whitelisted).length -
  acViolations.filter((v) => !v.whitelisted).length;
console.log(
  `\n依赖方向违规：${depTotal} 条（白名单 ${depWl}，新增 ${depTotal - depWl}）` +
    ` ｜ ports 纯度：${portsClassViolations.length} 条` +
    ` ｜ ports→实现层：${portsImplViolations.length} 条` +
    ` ｜ 依赖环：${cycleViolations.length} 组（新增 ${cycleViolations.filter((v) => !v.whitelisted).length}）` +
    ` ｜ 目录告警：${dirWarnings.length} 个`,
);
// **扫描面必须打印**（2026-10-06 第五十七轮 ③）：所有规则都是"在 collected 集合上判空"，
// 扫描范围塌缩（`src/` 改名/搬家/解析全失败）时五条规则会**同时空转而输出一模一样的"通过"**。
// 打印"扫了几个文件、几条边"之后，"零违规"与"零输入"在输出上就能分开。
console.log(`扫描面：${files.length} 个源文件 ｜ ${edges.length} 条相对导入边`);
if (files.length === 0) {
  console.error('❌ 架构门禁失败：扫描到 0 个源文件 ⇒ 五条规则全部无从判定（不是"零违规"）。');
  process.exit(1);
}

let exitCode = 0;
if (newCount > 0) {
  console.error(
    `\n❌ 架构门禁失败：发现 ${newCount} 条「白名单之外」的新增违规，提交/CI 中止。` +
      ` 存量请加入白名单或走 P1/P3 清偿流程，勿绕过。`,
  );
  exitCode = 1;
} else if (
  // 注意：这里**故意不含** cycleViolations 与 portsImplViolations——CI 的 `gate` job 跑的就是 `--strict`，
  // 而「存量 5 组环」与「ports→实现层的 21 条已登记类型契约」在清偿前必然存在，纳入即让 CI 恒红。
  // 两者的阻断都由上面的 newCount 承担（**新增即红**）；白名单清零后再把它们加进本条件。
  // （portsImpl 于 2026-10-11 动态全枚举时首次现形并登记，语义与环一致。）
  STRICT &&
  caViolations.length + acViolations.length + portsClassViolations.length > 0
) {
  console.error(
    `\n❌ 架构门禁失败（--strict）：仍有 ${
      caViolations.length + acViolations.length + portsClassViolations.length
    } 条白名单内存量违规未清偿。`,
  );
  exitCode = 1;
} else {
  console.log('\n✅ 架构门禁通过：无新增违规（存量已冻结于白名单，按批递减）。');
}

process.exit(exitCode);
