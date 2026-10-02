// scripts/auditInterfaces.mjs
//
// 接口层审计（无第三方依赖：node:fs / node:path / typescript）。
//
// 目的：把「`export interface X {}` 散落在实现文件里」这件事**机械量化**，并产出一份
// 「逐文件重构队列」，使重构可按文件推进、每个文件改完即验收。
//
// 三条口径（都可机械判定，不靠人工印象）：
//
//   1. **跨模块接口**（crossModule）——该 `interface` / `type` 被「声明所在 src 二级目录之外」
//      的文件引用。这类接口只能靠「实现文件 → 实现文件」的 import 才能共享，
//      是依赖环与耦合的根源，应升格为基础模块：`src/ports/<域>/<interfaceName>.ts`
//      （小驼峰文件名，与铁律 check.mjs 规则6 兼容；接口符号本身仍是 PascalCase），一接口一文件。
//      （声明所在目录内的引用不算跨模块——那是该功能的内部细节。）
//
//   2. **混装文件**（mixed）——同一文件既声明 `interface`/`type` 又声明 `class`/`function`，
//      即「契约与实现同居」，是职责缝所在。
//
//   3. **依赖环**（cycles）——模块级 import 图的强连通分量（Tarjan）。区分两种边：
//      - **运行时边**：导入绑定确实出现在**值位置**（`new X()` / 调用 / 装饰器 / `extends X`）；
//      - **类型边**：仅出现在类型位置（`x: X` / `implements X` / `typeof X` / `as X`），
//        编译后会被 TS 擦除，不产生运行时环，但仍造成**契约层的循环耦合**。
//      `extends` 必须算值位置（运行时需要该绑定存在），`implements` 算类型位置——不可一刀切。
//
// 用法：
//   node scripts/auditInterfaces.mjs               # 摘要 + TOP 列表
//   node scripts/auditInterfaces.mjs --top 60      # 调整 TOP 条数
//   node scripts/auditInterfaces.mjs --json out.json
//
// 退出码：审计模式恒为 0（本脚本只报事实，不做阻断；阻断由后续的 `--gate` 承担）。
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');
const argv = process.argv.slice(2);
const TOP = Number(readFlag('--top') ?? 40);
const JSON_OUT = readFlag('--json');

function readFlag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** 归一化为「正斜杠 + 相对仓库根」的路径，供所有前缀/集合比对复用。 */
const key = (p) => path.relative(ROOT, p).split(path.sep).join('/');

/** 模块所属的二级目录（`src/adapters/tool/x.ts` → `src/adapters`），用于判定「是否跨模块」。 */
const homeOf = (file) => file.split('/').slice(0, 2).join('/');

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** 把相对 specifier 解析为仓库内的真实文件（`.js` → `.ts`、目录 → `index.ts`）。 */
function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith('.')) return undefined;
  const base = path.resolve(path.dirname(fromFile), spec).split(path.sep).join('/');
  const cands = [];
  if (base.endsWith('.js')) cands.push(base.slice(0, -3) + '.ts');
  cands.push(base + '.ts', base + '/index.ts');
  return cands.find((c) => fs.existsSync(c));
}

/** 判断标识符引用是否位于**类型位置**（被 TS 擦除）；`extends` 例外：它是值位置。 */
function isTypePosition(node) {
  let cur = node;
  while (cur.parent) {
    const p = cur.parent;
    if (ts.isHeritageClause(p)) {
      // `implements X` 擦除；`extends X` 保留（运行时要取该绑定）
      return p.token === ts.SyntaxKind.ImplementsKeyword;
    }
    if (ts.isTypeNode(p)) return true;
    cur = p;
  }
  return false;
}

/** 收集文件内某本地名的所有**值位置**引用。 */
function hasValueUse(sf, name) {
  let found = false;
  (function visit(n) {
    if (found) return;
    if (ts.isIdentifier(n) && n.text === name) {
      const p = n.parent;
      const isBinding = (ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) && p.name === n;
      const isDeclName =
        (ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p)) && p.name === n;
      if (!isBinding && !isDeclName && !isTypePosition(n)) found = true;
    }
    ts.forEachChild(n, visit);
  })(sf);
  return found;
}

/** 解析一个文件的顶层声明与导入边。 */
function analyzeFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const types = [];
  const impls = [];
  const reexports = new Map(); // 本地名 -> 源文件（供穿透桶文件）
  const imports = []; // { local, from, value }
  for (const st of sf.statements) {
    if (ts.isInterfaceDeclaration(st)) types.push(decl(st, sf, 'interface'));
    else if (ts.isTypeAliasDeclaration(st)) types.push(decl(st, sf, 'type'));
    else if (ts.isClassDeclaration(st) || ts.isFunctionDeclaration(st))
      impls.push(st.name?.text ?? '(anonymous)');
    else if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const target = resolveSpecifier(file, st.moduleSpecifier.text);
      if (!target) continue;
      const clause = st.importClause;
      const nb = clause?.namedBindings;
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          const typeOnly = clause.isTypeOnly || el.isTypeOnly;
          imports.push({
            local: el.name.text,
            from: key(target),
            value: !typeOnly && hasValueUse(sf, el.name.text),
          });
        }
      } else if (!clause || (!nb && !clause.name)) {
        imports.push({ local: '*', from: key(target), value: true }); // 副作用导入
      } else if (nb && ts.isNamespaceImport(nb)) {
        imports.push({ local: nb.name.text, from: key(target), value: true });
      }
    } else if (
      ts.isExportDeclaration(st) &&
      st.moduleSpecifier &&
      ts.isStringLiteral(st.moduleSpecifier)
    ) {
      const target = resolveSpecifier(file, st.moduleSpecifier.text);
      if (!target) continue;
      const ec = st.exportClause;
      let typeOnly = st.isTypeOnly === true;
      if (ec && ts.isNamedExports(ec)) {
        if (ec.elements.length > 0 && ec.elements.every((el) => el.isTypeOnly)) typeOnly = true;
        for (const el of ec.elements) reexports.set(el.name.text, key(target));
      }
      // 关键：`export { X } from './y'` 是一条**真实的模块依赖边**——`X` 为值时运行时确实加载 `y`，
      // 为类型时被擦除。曾漏掉这条边（只记进 reexports 桶表），导致本脚本比架构门禁**少报一组环**
      // （`evolution/rlvrLoop` ↔ `evolution/inMemoryReplayBuffer`）。两处口径必须一致，以门禁为准。
      imports.push({ local: '*', from: key(target), value: !typeOnly });
    }
  }
  return { types, impls, imports, reexports };
}

function decl(st, sf, kind) {
  const mods = ts.canHaveModifiers(st) ? ts.getModifiers(st) : undefined;
  const exported = (mods ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  return {
    name: st.name.text,
    kind,
    exported,
    line: sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1,
  };
}

/** Tarjan 强连通分量，返回「真环」列表（size>1 或自环）。 */
function findCycles(graph) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const comps = [];
  let counter = 0;
  function strong(v) {
    index.set(v, counter);
    low.set(v, counter++);
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!graph.has(w)) continue;
      if (!index.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const comp = [];
      for (;;) {
        const w = stack.pop();
        onStack.delete(w);
        comp.push(w);
        if (w === v) break;
      }
      comps.push(comp);
    }
  }
  for (const v of graph.keys()) if (!index.has(v)) strong(v);
  return comps
    .filter((c) => c.length > 1 || (graph.get(c[0]) ?? new Set()).has(c[0]))
    .map((c) => c.slice().sort());
}

const files = walk(SRC, []);
const info = new Map(); // file -> analysis
for (const f of files) info.set(key(f), analyzeFile(f));

// ---- 依赖图 ----
const typeGraph = new Map();
const runtimeGraph = new Map();
for (const [file, a] of info) {
  typeGraph.set(file, new Set(a.imports.map((i) => i.from)));
  runtimeGraph.set(file, new Set(a.imports.filter((i) => i.value).map((i) => i.from)));
}

// ---- 跨模块判定（穿透桶文件的一层 re-export） ----
const declIndex = new Map(); // name -> Set(声明文件)
for (const [file, a] of info) {
  for (const t of a.types) {
    if (!t.exported) continue;
    if (!declIndex.has(t.name)) declIndex.set(t.name, new Set());
    declIndex.get(t.name).add(file);
  }
}
function* resolveDecl(file, name, depth = 0) {
  if (depth > 5) return;
  const a = info.get(file);
  if (!a) return;
  if (a.types.some((t) => t.name === name)) {
    yield file;
    return;
  }
  const next = a.reexports.get(name);
  if (next) yield* resolveDecl(next, name, depth + 1);
}

const usersOf = new Map(); // `${declFile}#${name}` -> Set(引用文件)
for (const [file, a] of info) {
  for (const im of a.imports) {
    if (im.local === '*') continue;
    for (const declFile of resolveDecl(im.from, im.local)) {
      const k = `${declFile}#${im.local}`;
      if (!usersOf.has(k)) usersOf.set(k, new Set());
      usersOf.get(k).add(file);
    }
  }
}

const rows = [];
for (const [file, a] of info) {
  for (const t of a.types) {
    const users = t.exported ? [...(usersOf.get(`${file}#${t.name}`) ?? [])] : [];
    const crossUsers = users.filter((u) => homeOf(u) !== homeOf(file));
    rows.push({ file, ...t, users, crossUsers, cross: t.exported && crossUsers.length > 0 });
  }
}

// ---- 汇总 ----
const outsidePorts = rows.filter((r) => !r.file.startsWith('src/ports/'));
const cross = outsidePorts.filter((r) => r.cross);
const mixedFiles = [...info.entries()]
  .filter(([, a]) => a.types.length > 0 && a.impls.length > 0)
  .map(([file, a]) => ({ file, types: a.types.length, impls: a.impls.length }));
const multiTypeFiles = [...info.entries()]
  .filter(([, a]) => a.types.filter((t) => t.exported).length > 1)
  .map(([file, a]) => ({ file, count: a.types.filter((t) => t.exported).length }));

const byDir = {};
for (const r of cross) {
  const d = homeOf(r.file);
  byDir[d] = byDir[d] ?? { types: 0, files: 0 };
  byDir[d].types++;
  byDir[d].files++;
}

const summary = {
  srcFiles: files.length,
  declaredTypes: rows.length,
  exportedTypes: rows.filter((r) => r.exported).length,
  filePrivateTypes: rows.filter((r) => !r.exported).length,
  portsTypes: rows.filter((r) => r.file.startsWith('src/ports/')).length,
  crossModuleTypesOutsidePorts: cross.length,
  crossModuleFilesOutsidePorts: new Set(cross.map((r) => r.file)).size,
  mixedFiles: mixedFiles.length,
  multiExportedTypeFiles: multiTypeFiles.length,
  cycles: { bySyntactic: findCycles(typeGraph).length, byRuntime: findCycles(runtimeGraph).length },
};

// ---- 重构队列计算（`--queue` / `--json` 共用） ----
/** 单目录直接 .ts 文件数上限（与 architectureGate.mjs [4] 的告警阈值一致）。 */
const DIR_FLAT_LIMIT = 30;

/**
 * 镜像规则的**唯一例外**：`ports` 是契约层、`adapters` 是实现层，**不得**出现 `src/ports/adapters/**`
 * （那会把「实现者」当成一个契约域，与六边形方向矛盾）。适配器声明的跨模块契约按它服务的端口域归位。
 * 未列入本表的适配器子域回退为同名域（`src/adapters/<子域>/x.ts` → `ports/<子域>/`）。
 */
const ADAPTER_DOMAIN_MAP = {
  approval: 'runtime',
  sandbox: 'runtime',
  model: 'model',
  tool: 'tool',
  media: 'media',
};

/**
 * 目标路径**显式覆盖表**：镜像规则给出的平铺路径在少数场景是错的——当 Batch A 已在目标域下建好
 * 功能组子目录（如 `ports/runtime/sandbox/`）时，同一概念的接口必须**并入该组**，否则同一契约会被
 * 拆到两处（`runtime/ApprovalRule.ts` 与 `runtime/approval/ApprovalDecision.ts`）。键为 `声明文件#接口名`。
 * 这是唯一的扩展点：执行中发现新的归组，请加到这里而不是手工改产物。
 */
const TARGET_OVERRIDES = {
  'src/adapters/approval/approvalRule.ts#ApprovalRule':
    'src/ports/runtime/approval/approvalRule.ts',
  'src/adapters/sandbox/networkEgressGuard.ts#NetworkEgressOptions':
    'src/ports/runtime/sandbox/networkEgressOptions.ts',
  'src/adapters/sandbox/sandboxManager.ts#SandboxProfile':
    'src/ports/runtime/sandbox/sandboxProfile.ts',
  'src/adapters/sandbox/sandboxCapabilityTable.ts#SandboxCapabilityEntry':
    'src/ports/runtime/sandbox/sandboxCapabilityEntry.ts',
  'src/adapters/tool/toolHandler.ts#ToolHandler': 'src/ports/tool/tool/toolHandler.ts',
  'src/adapters/model/modelRouter.ts#ModelRouterOptions':
    'src/ports/model/model/modelRouterOptions.ts',
  'src/adapters/model/modelRouter.ts#RouterStrategy': 'src/ports/model/model/routerStrategy.ts',
  'src/adapters/media/ffmpegFrameExtractor.ts#VideoFrameFormat':
    'src/ports/media/mediaTypes/videoFrameFormat.ts',
};

/**
 * 接口名（PascalCase）转文件名（camelCase）：仅首字母小写。
 * 铁律 scripts/check.mjs 规则6 要求 src 下任意 .ts 文件基名匹配 ^[a-z][a-zA-Z0-9]*$，
 * 故拆分后的接口文件名必须小驼峰；接口符号本身仍是 PascalCase（仅文件名变）。
 */
function toCamel(name) {
  if (name.length === 0) return name;
  const first = name.charAt(0);
  return /[A-Z]/.test(first) ? first.toLowerCase() + name.slice(1) : name;
}

/** 计算某个声明文件的迁移目标文件路径。 */
function migrationTarget(file, name) {
  const override = TARGET_OVERRIDES[`${file}#${name}`];
  if (override) return override;
  const seg = file.split('/');
  let domain = seg[1];
  if (domain === 'adapters') domain = ADAPTER_DOMAIN_MAP[seg[2]] ?? seg[2];
  return `src/ports/${domain}/${toCamel(name)}.ts`;
}

/** Batch A：ports 内「一个文件多个导出接口」→ 拆到 `<域>/<原文件基名>/<接口名>.ts`，原文件留桶。 */
const splitPlan = [...info.entries()]
  .filter(([, a]) => a.types.filter((t) => t.exported).length >= 2)
  .map(([file, a]) => {
    const names = a.types.filter((t) => t.exported).map((t) => t.name);
    const dir = path.posix.dirname(file);
    const base = path.posix.basename(file, '.ts');
    return {
      file,
      inPorts: file.startsWith('src/ports/'),
      count: names.length,
      names: names.slice().sort(),
      targetDir: `${dir}/${base}`,
    };
  })
  .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));

/** Batch B：ports 外的跨模块接口 → 落到 `src/ports/<域>/<接口名>.ts`（一接口一文件）。 */
const migrationPlan = cross
  .map((r) => ({
    ...r,
    targetFile: migrationTarget(r.file, r.name),
    barrel: r.file,
    needsGroupDir: false,
  }))
  .sort(
    (a, b) => b.crossUsers.length - a.crossUsers.length || a.targetFile.localeCompare(b.targetFile),
  );

// 目标目录文件数超限 ⇒ 需再下一级分组（否则触发 architectureGate [4] 的 >30 告警）
const targetDirCount = new Map();
for (const p of splitPlan) if (p.inPorts) targetDirCount.set(p.targetDir, p.count);
for (const m of migrationPlan) {
  const d = path.posix.dirname(m.targetFile);
  targetDirCount.set(d, (targetDirCount.get(d) ?? 0) + 1);
}
for (const [d, n] of targetDirCount) {
  if (n <= DIR_FLAT_LIMIT) continue;
  for (const p of splitPlan) if (p.targetDir === d) p.needsGroupDir = true;
  for (const m of migrationPlan) if (path.posix.dirname(m.targetFile) === d) m.needsGroupDir = true;
}

/** 重名冲突：同一接口名在两个及以上文件各自声明 —— 必须先「合并 or 改名」，否则迁进 ports 会撞名。 */
const byName = new Map();
for (const [file, a] of info) {
  for (const t of a.types) {
    if (!t.exported) continue;
    if (!byName.has(t.name)) byName.set(t.name, []);
    byName.get(t.name).push(file);
  }
}
const duplicates = [...byName.entries()]
  .filter(([, v]) => v.length >= 2)
  .sort((a, b) => b[1].length - a[1].length);

/** 已合规：只有一个导出接口的 ports 文件（无需拆）。 */
const portsCompliant = [...info.entries()].filter(
  ([file, a]) => file.startsWith('src/ports/') && a.types.filter((t) => t.exported).length === 1,
).length;

if (JSON_OUT) {
  fs.writeFileSync(
    JSON_OUT,
    JSON.stringify(
      {
        summary,
        splitPlan,
        migrationPlan,
        duplicates,
        crossedDirLimit: [...targetDirCount.entries()].filter(([, n]) => n > DIR_FLAT_LIMIT),
        mixedFiles,
        multiTypeFiles,
        cyclesSyntactic: findCycles(typeGraph),
        cyclesRuntime: findCycles(runtimeGraph),
      },
      null,
      1,
    ),
  );
}

if (argv.includes('--queue')) {
  console.log('# 接口层重构队列（自动生成：`node scripts/auditInterfaces.mjs --queue`）');
  console.log('');
  console.log('> 口径见 `docs/INTERFACE_REFACTOR_QUEUE.md`。所有数字为实测。');
  console.log('');
  console.log(
    `## Batch A — \`src/ports/**\` 内部拆分（${splitPlan.filter((p) => p.inPorts).length} 文件 / ${splitPlan.filter((p) => p.inPorts).reduce((s, p) => s + p.count, 0)} 接口）`,
  );
  console.log('');
  console.log('| 序 | 现文件 | 导出接口数 | 目标子目录 | 内容 | 超限？ |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  splitPlan
    .filter((p) => p.inPorts)
    .forEach((p, i) => {
      console.log(
        `| A${i + 1} | \`${p.file}\` | ${p.count} | \`${p.targetDir}/\` | ${p.names.join(' / ')} | ${p.needsGroupDir ? '⚠️ 需再分组' : '—'} |`,
      );
    });
  console.log('');
  console.log(
    `## Batch B — \`ports\` 外跨模块接口迁入（${migrationPlan.length} 接口 / ${new Set(migrationPlan.map((m) => m.barrel)).size} 文件）`,
  );
  console.log('');
  console.log('| 序 | 接口 | 现声明处 | 目标文件 | 域外引用者 | 总引用者 |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  migrationPlan.forEach((m, i) => {
    console.log(
      `| B${i + 1} | \`${m.name}\` (${m.kind}) | \`${m.file}:${m.line}\` | \`${m.targetFile}\` | ${m.crossUsers.length} | ${m.users.length} |`,
    );
  });
  console.log('');
  console.log(`## Batch C — 重名冲突（${duplicates.length} 组，须先决策「合并 or 改名」再迁）`);
  console.log('');
  if (duplicates.length === 0) console.log('（无）');
  else {
    console.log('| 接口名 | 声明处 |');
    console.log('| --- | --- |');
    duplicates.forEach(([name, list]) =>
      console.log(`| \`${name}\` | ${list.map((f) => `\`${f}\``).join(' ／ ')} |`),
    );
  }
  console.log('');
  console.log('## 无需动作');
  console.log('');
  console.log(`- ports 内已合规（单导出接口）文件：${portsCompliant} 个`);
  console.log(
    `- ports 外非跨模块类型（域内共享 ${outsidePorts.filter((r) => !r.cross && r.exported).length} + 文件私有 ${summary.filePrivateTypes}）：${outsidePorts.filter((r) => !r.cross).length} 个（域内细节，不迁）`,
  );
  const over = [...targetDirCount.entries()].filter(([, n]) => n > DIR_FLAT_LIMIT);
  console.log(
    `- 目标目录超 ${DIR_FLAT_LIMIT} 文件：${over.length === 0 ? '无' : over.map(([d, n]) => `\`${d}\` (${n})`).join('、')}`,
  );
  programExit();
}

function programExit() {
  process.exit(0);
}

const pad = (v, n) => String(v).padStart(n);
console.log('=== 接口层审计（scripts/auditInterfaces.mjs）===');
console.log(
  `src 文件 ${summary.srcFiles} ｜ 声明类型 ${summary.declaredTypes}（导出 ${summary.exportedTypes} / 文件私有 ${summary.filePrivateTypes}）`,
);
console.log(
  `ports 内 ${summary.portsTypes} ｜ ports 外跨模块 ${summary.crossModuleTypesOutsidePorts}（分布于 ${summary.crossModuleFilesOutsidePorts} 个文件）`,
);
console.log(
  `混装文件（契约+实现同居）${summary.mixedFiles} ｜ 单文件多导出类型 ${summary.multiExportedTypeFiles}`,
);
console.log(
  `依赖环：含类型边 ${summary.cycles.bySyntactic} 组 ｜ 仅运行时边 ${summary.cycles.byRuntime} 组`,
);

console.log(`\n--- 跨模块接口 TOP ${TOP}（应升格为基础模块；按域外引用者数排序） ---`);
const sorted = cross.slice().sort((a, b) => b.crossUsers.length - a.crossUsers.length);
for (const r of sorted.slice(0, TOP)) {
  console.log(
    `${pad(r.crossUsers.length, 3)}  ${r.file}:${r.line}  ${r.kind} ${r.name}  （域内+域外共 ${r.users.length}）`,
  );
}

console.log('\n--- 跨模块接口按所属目录汇总（= 逐文件重构的域顺序） ---');
for (const [d, v] of Object.entries(byDir).sort((a, b) => b[1].types - a[1].types)) {
  console.log(`${pad(v.types, 3)} 个接口 / ${pad(v.files, 2)} 文件  ${d}`);
}
