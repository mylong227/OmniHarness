// 接线完整性门禁（零依赖）。
//
// 目的：把本仓最高频缺陷形态「声明未接线」机器化。八批同型（D2/D3/D4/F3/F5/E3/E2/P5），
// 其共同机械根因都是四段链路（配置 → 装配 → 运行时 → 消费）中**某一段静默断裂**，
// 而 TypeScript 因字段可选 / 对象字面量展开而**不报错**。本门禁把六条不变量钉死：
//
//   I1  声明即被读：`OmniHarnessConfig` 上声明的每个字段，装配层必须真的读它（`partial.X`）。
//   I2  透传即被消费：`build()` 里逐字透传（`X: partial.X`）的字段，必须有 config 层之外的读取方，
//                    或显式登记进 `API_ONLY_FIELDS` 并写明理由（公开 API 面可合法只透传）。
//   I3  文件键已承认：`omniharness.json` 接受的每个 key，必须是全系统某处真实声明的字段（禁幽灵键）。
//   I4  旗标即被用：CLI 旗标表里解析取值的每个字段，必须真的被消费（`args.X` 或按旗标名取值）。
//   I5a 文件键即被消费：`FileConfig` 的每个顶层字段必须被 CLI 层引用（否则配置文件/env 写入后静默丢弃）。
//   I5b 映射即被透传：`configDefaults` 写进 `Partial<CliArgs>` 的每个字段必须被 CLI 装配层消费。
//
// 用法：node scripts/auditConfigWiring.mjs [--selftest]
// 退出码：0 = 全绿；1 = 存在未接线字段。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

const ROOT = process.cwd();
const key = (p) => p.split(sep).join('/');

/**
 * 递归收集目录下所有 .ts 文件（跳过 node_modules/dist/.git）。
 * @param dir 起始目录。
 * @returns 绝对路径（正斜杠归一）数组。
 */
function walkTs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
      out.push(...walkTs(p));
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      out.push(key(p));
    }
  }
  return out;
}

/**
 * 读入「相对仓库根路径 → 文本」。
 * @param files 绝对路径数组。
 * @returns 以相对路径为键的文本映射。
 */
function readTree(files) {
  const out = new Map();
  for (const f of files) out.set(f.replace(`${key(ROOT)}/`, ''), readFileSync(f, 'utf8'));
  return out;
}

/**
 * 找 `{` 的配对闭合下标（跳过嵌套）。
 * @param text 全文。
 * @param openIndex 左括号下标。
 * @returns 闭合括号下标；未闭合返回 -1。
 */
function balanced(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 抽取 `interface NAME {` 体内的**顶层**属性名（2 空格缩进；嵌套对象类型的键缩进更深，不计入）。
 * @param text 文件全文。
 * @param name 接口名。
 * @returns 去重后的字段名数组。
 */
function interfaceFields(text, name) {
  const start = text.indexOf(`interface ${name}`);
  if (start < 0) return [];
  const open = text.indexOf('{', start);
  const close = balanced(text, open);
  if (close < 0) return [];
  const body = text.slice(open, close + 1);
  return [
    ...new Set(
      [...body.matchAll(/^ {2}(?:readonly\s+)?([A-Za-z0-9_]+)\??\s*:/gm)].map((m) => m[1]),
    ),
  ];
}

/**
 * 抽取 `public static build(...)` 内 `return {` 的对象字面量文本。
 * @param text 文件全文。
 * @returns 字面量文本（含大括号）；未找到返回空串。
 */
function buildLiteral(text) {
  const at = text.indexOf('public static build(');
  if (at < 0) return '';
  const ret = text.indexOf('return {', at);
  if (ret < 0) return '';
  const open = text.indexOf('{', ret);
  const close = balanced(text, open);
  return close < 0 ? '' : text.slice(open, close + 1);
}

/**
 * 抽取某个方法体（按签名定位后取配对括号块）。
 * @param text 文件全文。
 * @param signature 方法签名前缀。
 * @returns 方法体文本（含大括号）；未找到返回空串。
 */
function methodBody(text, signature) {
  const at = text.indexOf(signature);
  if (at < 0) return '';
  const open = text.indexOf('{', at);
  if (open < 0) return '';
  const close = balanced(text, open);
  return close < 0 ? '' : text.slice(open, close + 1);
}

/**
 * 收集某文件里 `new Set(...[...])` / `= [...]` 形式的字符串常量集合。
 * @param text 文件全文。
 * @returns 常量名 → 字符串数组。
 */
function literalSets(text) {
  const sets = new Map();
  for (const m of text.matchAll(
    /const ([A-Z_][A-Z0-9_]*)[^=]*=\s*new Set<?[^[]*\(\[([\s\S]*?)\]\);/g,
  )) {
    sets.set(
      m[1],
      [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]),
    );
  }
  for (const m of text.matchAll(/const ([A-Z_][A-Z0-9_]*)[^=]*=\s*\[([\s\S]*?)\];/g)) {
    sets.set(
      m[1],
      [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]),
    );
  }
  return sets;
}

/**
 * 展开一层 `...CONST` / `...Object.keys(CONST)` 引用，取 KNOWN_KEYS 的扁平字符串集合。
 * @param text configError.ts 全文。
 * @returns 已知配置键数组。
 */
function expandKnownKeys(text) {
  const sets = literalSets(text);
  const at = text.indexOf('KNOWN_KEYS');
  if (at < 0) return [];
  const open = text.indexOf('([', at);
  const close = text.indexOf('])', open);
  const body = text.slice(open, close);
  const out = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const m of body.matchAll(/\.\.\.Object\.keys\(([A-Za-z0-9_]+)\)/g))
    out.push(...(sets.get(m[1]) ?? []));
  for (const m of body.matchAll(/\.\.\.([A-Z_][A-Z0-9_]*)\b/g)) out.push(...(sets.get(m[1]) ?? []));
  return [...new Set(out)];
}

/**
 * 抽取 KEY_ALIASES 的值集（标准 key）。
 * @param text configError.ts 全文。
 * @returns 标准键数组。
 */
function keyAliasValues(text) {
  const at = text.indexOf('KEY_ALIASES');
  if (at < 0) return [];
  const open = text.indexOf('{', at);
  const close = balanced(text, open);
  if (close < 0) return [];
  return [...new Set([...text.slice(open, close + 1).matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]))];
}

/** 驼峰 → 旗标名（camelCase → --kebab-case）。 */
const kebab = (s) => s.replace(/([A-Z])/g, '-$1').toLowerCase();

// 显式豁免（每条都要写明理由；登记项失效会被反向检查，防白名单腐化）。
/** 输入端口在装配期就已被交给真正的消费者，ResolvedConfig 上保留的只是镜像。 */
const API_ONLY_FIELDS = {
  runtimeTelemetry:
    '输入端口已在装配期交给 SparkController（sparkAssembler.ts:107 → cycle telemetry）；ResolvedConfig 保留镜像供库内嵌方读取',
};
/** 由非 CLI 层消费的文件配置字段（CLI 不使用）。 */
const SERVER_ONLY_FIELDS = {
  workspaces:
    '多工作区列表由服务端消费（serverConfigStore.fileConfig().workspaces 的增删与列表），CLI 只认单一 workspaceRoot',
};

/**
 * 跑六条不变量。
 * @param tree 相对路径 → 文本 的映射，须含 `src/**`。
 * @returns 违规列表（空 = 全绿）。
 */
export function audit(tree) {
  const violations = [];
  const factory = tree.get('src/config/configFactory.ts') ?? '';
  const errText = tree.get('src/config/configError.ts') ?? '';
  const fileCfgText = tree.get('src/config/configFile.ts') ?? '';
  const flagTable = tree.get('src/cli/cliFlagTable.ts') ?? '';
  const argParser = tree.get('src/cli/argParser.ts') ?? '';

  const cfgFields = interfaceFields(factory, 'OmniHarnessConfig');
  if (cfgFields.length === 0)
    throw new Error('未能从 configFactory.ts 解析出 OmniHarnessConfig 字段');

  const configTexts = [...tree.entries()]
    .filter(([p]) => p.startsWith('src/config/'))
    .map(([, t]) => t);
  const outsideConfig = [...tree.entries()]
    .filter(([p]) => p.startsWith('src/') && !p.startsWith('src/config/'))
    .map(([, t]) => t);
  const cliTexts = [...tree.entries()].filter(([p]) => p.startsWith('src/cli/')).map(([, t]) => t);
  const cliOutsideFlagTable = [...tree.entries()]
    .filter(([p]) => p.startsWith('src/cli/') && p !== 'src/cli/cliFlagTable.ts')
    .map(([, t]) => t);

  // I1 声明即被读
  for (const f of cfgFields) {
    if (!configTexts.some((t) => new RegExp(`\\bpartial\\.${f}\\b`).test(t))) {
      violations.push({
        id: 'I1',
        detail: `OmniHarnessConfig.${f} 无人读（装配层无 partial.${f}）`,
      });
    }
  }

  // I2 透传即被消费
  const literal = buildLiteral(factory);
  const carried = [...literal.matchAll(/^\s*([A-Za-z0-9_]+):\s*partial\.([A-Za-z0-9_]+)\s*,?$/gm)]
    .filter((m) => m[1] === m[2])
    .map((m) => m[1]);
  for (const f of carried) {
    if (API_ONLY_FIELDS[f] !== undefined) continue;
    if (!outsideConfig.some((t) => new RegExp(`\\.${f}\\b`).test(t))) {
      violations.push({ id: 'I2', detail: `build() 透传 ${f} 但 config 层之外无消费方` });
    }
  }
  for (const f of Object.keys(API_ONLY_FIELDS)) {
    if (!carried.includes(f)) {
      violations.push({
        id: 'I2',
        detail: `API_ONLY_FIELDS 豁免「${f}」已失效（不再是 build() 逐字透传字段），请删除该登记`,
      });
    }
  }

  // I3 文件键已承认（禁幽灵键）
  const declared = new Set(cfgFields);
  for (const [p, t] of tree.entries()) {
    if (!p.startsWith('src/config/') && !p.startsWith('src/cli/')) continue;
    for (const m of t.matchAll(/^\s*(?:readonly\s+)?([A-Za-z0-9_]+)\??\s*:/gm)) declared.add(m[1]);
  }
  for (const k of [...expandKnownKeys(errText), ...keyAliasValues(errText)]) {
    if (!declared.has(k)) {
      violations.push({ id: 'I3', detail: `配置键 ${k} 被接受但全系统无同名字段声明（幽灵键）` });
    }
  }

  // I4 旗标即被用
  const assigned = [
    ...new Set(
      [...flagTable.matchAll(/a\.([A-Za-z0-9_]+)\s*(?:=[^=]|\.(?:push|unshift)\()/g)].map(
        (m) => m[1],
      ),
    ),
  ];
  for (const f of assigned) {
    const byArgs = new RegExp(`\\bargs\\.${f}\\b`);
    const byFlagName = cliOutsideFlagTable.some((t) => t.includes(`'--${kebab(f)}'`));
    if (!byFlagName && !cliOutsideFlagTable.some((t) => byArgs.test(t))) {
      violations.push({
        id: 'I4',
        detail: `CLI 旗标字段 ${f} 被解析但无人消费（既无 args.${f}，也无 '--${kebab(f)}' 取值）`,
      });
    }
  }

  // I5a 文件键即被消费
  const fileFields = interfaceFields(fileCfgText, 'FileConfig');
  const cliJoined = cliTexts.join('\n');
  for (const f of fileFields) {
    if (SERVER_ONLY_FIELDS[f] !== undefined) continue;
    if (!new RegExp(`\\b${f}\\b`).test(cliJoined)) {
      violations.push({
        id: 'I5a',
        detail: `FileConfig.${f} 被配置文件/env 接受但 CLI 层零引用（写入后静默丢弃）`,
      });
    }
  }
  for (const f of Object.keys(SERVER_ONLY_FIELDS)) {
    if (!fileFields.includes(f)) {
      violations.push({
        id: 'I5a',
        detail: `SERVER_ONLY_FIELDS 豁免「${f}」已失效（不再是 FileConfig 顶层字段），请删除该登记`,
      });
    }
  }

  // I5b 映射即被透传
  const written = [
    ...new Set(
      [
        ...methodBody(argParser, 'configDefaults(file').matchAll(/result\.([A-Za-z0-9_]+)\s*=/g),
      ].map((m) => m[1]),
    ),
  ];
  for (const f of written) {
    const byArgs = new RegExp(`\\bargs\\.${f}\\b`);
    const byFlagName = cliOutsideFlagTable.some((t) => t.includes(`'--${kebab(f)}'`));
    if (!byFlagName && !cliOutsideFlagTable.some((t) => byArgs.test(t))) {
      violations.push({
        id: 'I5b',
        detail: `configDefaults 写入 ${f} 但 CLI 装配层未消费（args.${f} / '--${kebab(f)}' 皆无）`,
      });
    }
  }

  return violations;
}

/** 自证「不是假绿」：每条不变量都用一个合成输入验证确实会触发（I2b 为反向用例）。 */
function selftest() {
  const cfg = (body) =>
    `interface OmniHarnessConfig {\n  readonly real: number;\n${body}}\nclass X {\n  public static build(partial: OmniHarnessConfig): ResolvedConfig {\n    return {\n      real: partial.real,\n    };\n  }\n}\n`;
  const cases = [
    { id: 'I1', tree: { 'src/config/configFactory.ts': cfg('  readonly ghost: number;\n') } },
    {
      id: 'I2',
      tree: {
        'src/config/configFactory.ts': `interface OmniHarnessConfig {\n  readonly ghost: number;\n}\nclass X {\n  public static build(partial: OmniHarnessConfig): ResolvedConfig {\n    return {\n      ghost: partial.ghost,\n    };\n  }\n}\n`,
      },
    },
    {
      id: 'I3',
      tree: {
        'src/config/configFactory.ts': cfg(''),
        'src/config/configError.ts':
          "const KNOWN_KEYS: ReadonlySet<string> = new Set<string>([\n  'phantom',\n]);\n",
      },
    },
    {
      id: 'I4',
      tree: {
        'src/config/configFactory.ts': cfg(''),
        'src/cli/cliFlagTable.ts': 'a.ghost = 1;\n',
        'src/cli/argParser.ts': 'export interface CliArgs {\n  ghost?: number;\n}\n',
      },
    },
    {
      id: 'I5a',
      tree: {
        'src/config/configFactory.ts': cfg(''),
        'src/config/configFile.ts':
          'export interface FileConfig {\n  readonly ghostKey?: number;\n}\n',
        'src/cli/argParser.ts': 'export interface CliArgs {\n  real?: number;\n}\n',
      },
    },
    {
      id: 'I5b',
      tree: {
        'src/config/configFactory.ts': cfg(''),
        'src/cli/argParser.ts':
          'export interface CliArgs {\n  mapped?: number;\n}\n  public configDefaults(file: FileConfig): Partial<CliArgs> {\n    const result: Partial<CliArgs> = {};\n    result.mapped = 1;\n    return result;\n  }\n',
        'src/cli/cliOther.ts': 'export const unused = 1;\n',
      },
    },
    {
      id: 'I2b',
      tree: {
        'src/config/configFactory.ts': `interface OmniHarnessConfig {\n  readonly runtimeTelemetry: number;\n}\nclass X {\n  public static build(partial: OmniHarnessConfig): ResolvedConfig {\n    return {\n      runtimeTelemetry: partial.runtimeTelemetry,\n    };\n  }\n}\n`,
      },
    },
  ];
  let pass = true;
  for (const c of cases) {
    const found = audit(new Map(Object.entries(c.tree)));
    // I2b 是**反向**用例：已知的合法豁免必须**不**被报出（防白名单被误用为掩盖真实缺口）。
    const hit =
      c.id === 'I2b' ? !found.some((v) => v.id === 'I2') : found.some((v) => v.id === c.id);
    if (!hit) pass = false;
    console.log(
      `  selftest ${hit ? '✓' : '✗'} ${c.id} ${hit ? '符合预期' : '**不符合预期（护栏失真）**'}`,
    );
  }
  if (!pass) {
    console.error('[auditConfigWiring] selftest 失败');
    return 1;
  }
  console.log('[auditConfigWiring] selftest 全部通过');
  return 0;
}

if (process.argv.includes('--selftest')) {
  process.exit(selftest());
}

const tree = readTree(walkTs(join(ROOT, 'src')));
const violations = audit(tree);
if (violations.length === 0) {
  console.log(`[auditConfigWiring] ✓ 接线完整性全绿（${tree.size} 个源文件）`);
  process.exit(0);
}
console.error(`[auditConfigWiring] ✗ 发现 ${violations.length} 处未接线：`);
for (const v of violations) console.error(`  [${v.id}] ${v.detail}`);
console.error(
  '[auditConfigWiring] 说明：新增配置字段时须同时接通「配置 → 装配 → 运行时 → 消费」四段。',
);
process.exit(1);
