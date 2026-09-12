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
// 零依赖：仅用 node:fs / node:path / typescript（已为 devDependency）。
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
// core→adapters（7 条，docs §1.3；checkpointManager→gitWorkspaceSnapshot 已 P1 解耦清零）
const CORE_TO_ADAPTERS_WL = new Set([
  'core/runtime->adapters/memory/memoryExtractor',
  'core/runtime->adapters/live/consoleLiveView',
  'core/runtime->adapters/embedding/transformersEmbeddingAdapter',
  'core/runtime->adapters/live/compositeLiveView',
  'core/stepRunner->adapters/sandbox/denial',
  'core/toolGate->adapters/sandbox/unsupportedSandbox',
  'core/turnRunner->adapters/memory/memoryExtractor',
]);
// adapters→core（1 条，docs §1.3；已清 8：eventFactory 簇 x4 + checkpointTool/rollbackTool x2
//   + turnDiffHooks x2 经端口注入清零，剩余 1 条为真实存量）
const ADAPTERS_TO_CORE_WL = new Set(['adapters/tool/runGoalTool->core/agent']);
// ports 纯度：允许 ports/model.ts 内含 2 个错误类（P3.x 拆分到 errors 端口或独立模块后移除）
const PORTS_CLASS_WL = new Set(['src/ports/model.ts']);

// ---- 4. 判定 ----
const caViolations = [];
const acViolations = [];
for (const { from, to } of edges) {
  const id = `${from}->${to}`;
  if (from.startsWith('core/') && to.startsWith('adapters/')) {
    caViolations.push({ id, whitelisted: CORE_TO_ADAPTERS_WL.has(id) });
  } else if (from.startsWith('adapters/') && to.startsWith('core/')) {
    acViolations.push({ id, whitelisted: ADAPTERS_TO_CORE_WL.has(id) });
  }
}

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
  const classRe = /\bclass\s+[A-Za-z0-9_]+/g;
  let cm;
  while ((cm = classRe.exec(text))) {
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
  portsClassViolations.filter((v) => !v.whitelisted).length;

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
    ` ｜ 目录告警：${dirWarnings.length} 个`,
);

let exitCode = 0;
if (newCount > 0) {
  console.error(
    `\n❌ 架构门禁失败：发现 ${newCount} 条「白名单之外」的新增违规，提交/CI 中止。` +
      ` 存量请加入白名单或走 P1/P3 清偿流程，勿绕过。`,
  );
  exitCode = 1;
} else if (STRICT && caViolations.length + acViolations.length + portsClassViolations.length > 0) {
  console.error(
    `\n❌ 架构门禁失败（--strict）：仍有 ${caViolations.length + acViolations.length + portsClassViolations.length} 条白名单内存量违规未清偿。`,
  );
  exitCode = 1;
} else {
  console.log('\n✅ 架构门禁通过：无新增违规（存量已冻结于白名单，按批递减）。');
}

process.exit(exitCode);
