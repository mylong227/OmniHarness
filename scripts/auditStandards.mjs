// AST-based standards audit using the TypeScript compiler API.
// Measures each src/*.ts file against the 8 new code standards precisely.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { execFile } from 'node:child_process';

const root = 'src';
const HOT = new Set([
  'src/core/stepRunner.ts',
  'src/core/turnRunner.ts',
  'src/ports/toolInputSink.ts',
]);
const isHot = (f) =>
  f.split(path.sep).join('/').startsWith('src/adapters/live/') ||
  HOT.has(f.split(path.sep).join('/'));

const files = [];
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (['tests', 'node_modules', 'dist'].includes(e.name)) continue;
      walk(p);
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) files.push(p);
  }
}
walk(root);

// ---- import graph (fan-in) ----
function key(f) {
  return f
    .split(path.sep)
    .join('/')
    .replace(/^src\//, '')
    .replace(/\.ts$/, '');
}
const fanIn = new Map();
const outgoing = new Map(); // 文件 → 其 import 解析后的模块 key 列表（出边），供 core→adapters 度量
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const re = /(?:from\s+|import\s*\(\s*)(['"])([^'"]+)\1/g;
  let m;
  const targets = [];
  while ((m = re.exec(src))) {
    let spec = m[2];
    if (!spec.startsWith('.')) continue;
    let resolved = path.posix.normalize(path.posix.join(path.posix.dirname(key(f)), spec));
    resolved = resolved.replace(/\.js$/, '').replace(/\/index$/, '');
    fanIn.set(resolved, (fanIn.get(resolved) || 0) + 1);
    targets.push(resolved);
  }
  outgoing.set(key(f), targets);
}

const hasJsDoc = (node, sf) => {
  const ranges = ts.getLeadingCommentRanges(sf.text, node.pos) || [];
  return ranges.some((r) => sf.text.slice(r.pos, r.pos + 3) === '/**');
};

/**
 * 取节点前导的 JSDoc 注释全文（若有）。供 P0.2 细粒度覆盖度量检测 @param / @returns。
 *
 * @param node 语法节点
 * @param sf 源文件
 * @returns JSDoc 文本，无则 null
 */
const getJsDocComment = (node, sf) => {
  const ranges = ts.getLeadingCommentRanges(sf.text, node.pos) || [];
  for (const r of ranges) {
    const txt = sf.text.slice(r.pos, r.end);
    if (txt.startsWith('/**')) return txt;
  }
  return null;
};

/**
 * P0.2 注释细粒度覆盖度量（AST 实测，口径对齐 docs/REFACTOR_BOARD §1.2）：
 *  - 类方法（排除构造器）有参 → @param 覆盖
 *  - 类方法（排除构造器）有显式返回类型 → @returns 覆盖
 *  - 类字段（PropertyDeclaration）→ 注释覆盖
 *
 * @param text 源码文本
 * @param fileName 文件名
 * @returns 覆盖计数对象（各维度分子/分母）
 */
function collectCommentMetrics(text, fileName) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  let methodsTotal = 0;
  let methodsWithParams = 0;
  let methodsWithParamsParam = 0;
  let methodsWithRet = 0;
  let methodsWithRetReturns = 0;
  let propsTotal = 0;
  let propsWithJsdoc = 0;
  let classesTotal = 0;
  let classesWithJsdoc = 0;
  const visit = (node) => {
    if (ts.isClassDeclaration(node)) {
      classesTotal++;
      if (getJsDocComment(node, sf)) classesWithJsdoc++;
      for (const mem of node.members) {
        if (ts.isPropertyDeclaration(mem)) {
          propsTotal++;
          if (getJsDocComment(mem, sf)) propsWithJsdoc++;
        } else if (ts.isMethodDeclaration(mem) && !ts.isConstructorDeclaration(mem)) {
          methodsTotal++;
          const hasParams = mem.parameters.length > 0;
          const hasRet = !!mem.type;
          const jsdoc = getJsDocComment(mem, sf);
          if (hasParams) {
            methodsWithParams++;
            if (jsdoc && /@param\b/.test(jsdoc)) methodsWithParamsParam++;
          }
          if (hasRet) {
            methodsWithRet++;
            if (jsdoc && /@returns?\b/.test(jsdoc)) methodsWithRetReturns++;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return {
    methodsTotal,
    methodsWithParams,
    methodsWithParamsParam,
    methodsWithRet,
    methodsWithRetReturns,
    propsTotal,
    propsWithJsdoc,
    classesTotal,
    classesNoJsdoc: classesTotal - classesWithJsdoc,
  };
}

/**
 * 对单份源码文本计算标准度量（不依赖文件 IO，供全量扫描与 `--delta` 增量对比复用）。
 *
 * @param text 源码文本
 * @param fileName 文件名（用于「主类名 ↔ 文件名」匹配）
 * @returns 该文件的度量对象（行数、var/any 计数、类清单、公开成员 JSDoc 缺口、上帝类判定等）
 */
function metricsForSource(text, fileName) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  // P4.4：细粒度注释覆盖（类 JSDoc / @param / @returns / 字段注释）并入单文件度量。
  const comment = collectCommentMetrics(text, fileName);
  const base = path.basename(fileName).replace(/\.ts$/, '');
  const lines = text.split('\n').length;
  let varCount = 0,
    anyCount = 0,
    classes = [],
    topFns = [],
    staticCount = 0;
  let expFnsNoJsdoc = 0,
    expFnsNoRet = 0;
  const missingJsdoc = [];
  let membersNoAccess = 0,
    membersTotal = 0,
    publicNoJsdoc = 0,
    publicTotal = 0;
  const exportedClasses = [];

  const visit = (node) => {
    if (ts.isVariableStatement(node)) {
      if (
        (node.declarationList.flags & ts.NodeFlags.Let) === 0 &&
        (node.declarationList.flags & ts.NodeFlags.Const) === 0
      )
        varCount++;
    }
    if (node.kind === ts.SyntaxKind.AnyKeyword) anyCount++;
    if (ts.isFunctionDeclaration(node)) {
      const name = node.name ? node.name.text : '(anonymous)';
      const exported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      topFns.push({ name, exported: !!exported, jsdoc: hasJsDoc(node, sf), ret: !!node.type });
      if (exported) {
        if (!hasJsDoc(node, sf)) expFnsNoJsdoc++;
        if (!node.type) expFnsNoRet++;
      }
    }
    if (ts.isClassDeclaration(node)) {
      const cname = node.name ? node.name.text : '(anonymous)';
      const exported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      let methods = 0;
      for (const mem of node.members) {
        membersTotal++;
        const mods = mem.modifiers || [];
        const hasAccess = mods.some((m) =>
          [
            ts.SyntaxKind.PublicKeyword,
            ts.SyntaxKind.PrivateKeyword,
            ts.SyntaxKind.ProtectedKeyword,
          ].includes(m.kind),
        );
        const isStatic = mods.some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
        if (isStatic) staticCount++;
        if (ts.isMethodDeclaration(mem) || ts.isPropertyDeclaration(mem)) {
          methods++;
          if (!hasAccess) membersNoAccess++;
          // public = explicit public OR no access modifier (default public)
          const isPrivate = mods.some((m) =>
            [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword].includes(m.kind),
          );
          if (!isPrivate) {
            publicTotal++;
            if (!hasJsDoc(mem, sf)) {
              publicNoJsdoc++;
              const nm = mem.name ? mem.name.getText(sf) : '(ctor)';
              missingJsdoc.push({
                name: nm,
                line: sf.getLineAndCharacterOfPosition(mem.getStart()).line + 1,
              });
            }
          }
        } else if (!hasAccess) membersNoAccess++;
      }
      classes.push({ name: cname, methods, exported: !!exported, jsdoc: hasJsDoc(node, sf) });
      if (exported) exportedClasses.push(cname);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const mainClass = classes.find((c) => c.exported)?.name;
  const nameMatches = mainClass
    ? mainClass.toLowerCase() === base.toLowerCase() ||
      mainClass.toLowerCase().replace(/[^a-z]/g, '') === base.toLowerCase().replace(/[^a-z]/g, '')
    : true;
  const maxMethods = Math.max(0, ...classes.map((c) => c.methods));
  // 口径修正记录（D7，2026-09-13）：上帝类的行数判据由「原始行数」改为「代码行数」（剔注释与空行）。
  // 原口径为什么错：P4.2/P4.3 补 JSDoc 是标准要求的标准动作，但注释行会把 500 行边的实现推过
  // 上帝类阈值——度量在惩罚补文档（实测 openAiCompatibleModel/cliBuildConfig/oidcClient 三文件
  // 因补注释 490→510 行被误判）。行数判据意在衡量**实现体量**，注释/空行不属于实现。
  // 反例留档：commit 前后仅差注释行，逻辑零变化却被判上帝类。>25 方法判据不受影响。
  let codeLines = 0;
  for (const ln of text.split('\n')) {
    const t = ln.trim();
    if (
      t === '' ||
      t.startsWith('//') ||
      t.startsWith('*') ||
      t.startsWith('/*') ||
      t.endsWith('*/')
    )
      continue;
    codeLines++;
  }
  const godClass = classes.length > 0 && (codeLines > 500 || maxMethods > 25);
  return {
    file: fileName,
    lines,
    codeLines,
    varCount,
    anyCount,
    classes,
    topFns,
    staticCount,
    expFnsNoJsdoc,
    expFnsNoRet,
    membersNoAccess,
    membersTotal,
    publicNoJsdoc,
    publicTotal,
    mainClass,
    nameMatches,
    missingJsdoc,
    godClass,
    exportedCount: exportedClasses.length,
    // P4.4（注释门禁化）：并入 P0.2 细粒度注释覆盖，供 --delta 增量比对「新增缺注释」。
    // 差值口径：缺口 = 应有数 − 已覆盖数（方法级/字段级，非参数级）。
    classesNoJsdoc: comment.classesNoJsdoc,
    paramGap: comment.methodsWithParams - comment.methodsWithParamsParam,
    returnsGap: comment.methodsWithRet - comment.methodsWithRetReturns,
    fieldGap: comment.propsTotal - comment.propsWithJsdoc,
    // 生产级实现标准（CODE_STANDARD §12）：占位/调试残留计数（只增即红，存量不拦）。
    placeholderCount: placeholderMarkers(sf, text),
  };
}

/**
 * 统计「占位实现 / 调试残留」标记数（CODE_STANDARD §12.2 的机械面）。
 *
 * 口径（**只数会被当成"以后再说"的东西**，不数正常注释里的中文说明）：
 * - 待办标记：`TODO` / `FIXME` / `XXX` / `HACK`（词边界 + 区分大小写，避免 `HACKATHON` / `todoPort` 误伤）；
 * - 调试残留：`console.log(` / `console.debug(` / `debugger`（本仓有 `log` 与 `process.stdout.write` 两条正道）；
 * - 占位实现：`not implemented` / `not-implemented`；
 * - 类型逃逸：裸 `@ts-ignore` / `@ts-expect-error`；
 * - **注释保留**：`// TODO: 以后再补` 这类真待办正是要数的东西。
 *
 * **为什么用 AST 掩码而不是正则剥字符串**（第一版就是正则，当场被自己的判据抓到）：
 * 正则 `/\`(?:\\.|[^\`\\])*\`/` 遇到**嵌套模板字面量**（模板里再写模板）会提前闭合，
 * 于是「文档/夹具里提到 TODO」被当成真待办——本仓历史同型教训见 `check.mjs`「由正则启发式改用
 * TypeScript AST」。故此处按 AST 取字符串/模板/正则字面量的**区间**并整体抹白（保留换行以维持行号），
 * 注释不是 AST 节点、天然保留。
 *
 * **文档口吻 vs 待办口吻（约定）**：注释里**用反引号包裹**的标记 = 在讨论这个概念本身
 * （如本段与判据里的 `` `TODO` ``），不计；**裸露**的标记 = 真待办（`// TODO: 以后再补`），计。
 * 这条约定让「写文档/写规则的人」不必为了过门禁而把话说含糊。
 *
 * **为什么只做"只增即红"**：存量里可能有正当例外（例如"假完成探测器"自己的注释在讨论这个概念）；
 * §12 的纪律要求「新增不再产生」，而不是「一夜之间清空历史」。全量计数仍会打印，供跟踪收口。
 *
 * @param sf 该文件的 TypeScript SourceFile（复用 `metricsForSource` 已解析的那一份）
 * @param text 源码文本
 * @returns 命中次数（0 = 干净）
 */
function placeholderMarkers(sf, text) {
  const chars = [...text];
  const blank = (from, to) => {
    for (let i = from; i < to && i < chars.length; i += 1) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  };
  const visit = (node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node) ||
      // 正则字面量同理：`/TODO|FIXME/` 是**在描述**标记（写规则/写判据的人必然会写），不是待办。
      ts.isRegularExpressionLiteral(node)
    ) {
      // 整个字面量（含模板里的 `${…}` 表达式）一并抹白：宁可少报，不可误报。
      blank(node.getStart(sf), node.getEnd());
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // 注释里被反引号包裹的片段 = 文档口吻（见上方约定）：同样抹白。
  const code = chars.join('').replace(/`[^`\n]*`/g, (span) => ' '.repeat(span.length));
  const patterns = [
    /\b(?:TODO|FIXME|XXX|HACK)\b/g,
    /\bconsole\.(?:log|debug)\s*\(/g,
    /\bdebugger\b/g,
    /\bnot[- ]implemented\b/gi,
    /@ts-(?:ignore|expect-error)\b/g,
  ];
  let hits = 0;
  for (const re of patterns) {
    hits += (code.match(re) ?? []).length;
  }
  return hits;
}

/**
 * 统计「JSDoc 续行缩进 ≠ 注释起始列 + 1」的行数。
 *
 * 为什么需要：全仓曾有 **216 处** `@returns 无返回值。` 是在自动补写文档时被追加到 JSDoc **块外**的
 * （缩进只剩 0–2 空格），渲染/阅读时会被当成块外内容；Prettier 不管 JSDoc 续行缩进，现有门禁也不查，
 * 于是这类「注释脱块」能长期存在。本函数用 TS scanner 取多行注释（**不误伤字符串/模板里的 `/**`**），
 * 只检查以 `*` 开头的续行（空行与块内代码块以外的行不计）。
 *
 * 注意：本规则**不**禁止 `void` 方法写 `@returns` —— `auditStandards.mjs` 的增量门禁第
 * 「方法缺@returns」项把「有显式返回类型的方法」（含 `void` / `Promise<void>`）计入分母，
 * `@returns 无返回值。` 正是满足该项的合规写法；要改这一政策须先改那条门禁的口径，不在本规则范围。
 *
 * @param text 源码文本
 * @returns 违约行数
 */
function jsdocIndentViolations(text) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.ES2022,
    false,
    ts.LanguageVariant.Standard,
    text,
  );
  let count = 0;
  // 模板字面量栈：每层记录该模板当前 `${…}` 内的花括号深度。
  //
  // 为什么需要它（2026-10-06 第六十一轮实测的**假红**）：裸 `scanner` 不是 parser，走到 `}` 时
  // 不会自动 `reScanTemplateToken`，于是**模板文本里的** `/**` 被当成注释起点，扫描一路吞到
  // 下一个真注释的 `*/` 才结束——那一整段真 JSDoc 于是被判成「脱块」。实测一份
  // `:(exclude)${dir}/**` 让紧随其后 6 行完全合规的 JSDoc 集体变红。上面「不误伤字符串/模板」
  // 的声明此前并不成立：字符串字面量确实没事，模板字面量会炸。
  const templateStack = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (templateStack.length > 0) {
      if (kind === ts.SyntaxKind.TemplateHead) {
        templateStack.push(0); // 模板里再套模板
      } else if (kind === ts.SyntaxKind.OpenBraceToken) {
        templateStack[templateStack.length - 1] += 1;
      } else if (kind === ts.SyntaxKind.CloseBraceToken) {
        if (templateStack[templateStack.length - 1] === 0) {
          // 这个 `}` 关闭 `${…}`：重扫为模板中段/尾段，模板内文本不再当注释看。
          if (scanner.reScanTemplateToken(false) === ts.SyntaxKind.TemplateTail) {
            templateStack.pop();
          }
        } else {
          templateStack[templateStack.length - 1] -= 1;
        }
      }
      continue;
    }
    if (kind === ts.SyntaxKind.TemplateHead) {
      templateStack.push(0);
      continue;
    }
    if (kind !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
    const start = scanner.getTokenStart();
    const raw = text.slice(start, scanner.getTokenEnd());
    if (!raw.startsWith('/**')) continue; // 只约束 JSDoc，普通块注释不强制对齐
    const lineStart = text.lastIndexOf('\n', start) + 1;
    // BOM 是文件头字节序标记，不是缩进的一部分——不扣除会把 41 个带 BOM 的 .ts 全体误判（实测）。
    const bom = lineStart === 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0;
    const openCol = start - lineStart - bom;
    const lines = raw.split('\n');
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trimStart();
      if (trimmed === '' || !trimmed.startsWith('*')) continue;
      if (line.length - trimmed.length !== openCol + 1) count += 1;
    }
  }
  return count;
}

// `--self-check-jsdoc`：规则自证（正例 + 反例成对）。
//
// 存在理由（2026-10-06 第六十一轮实测的**假红**）：模板字面量里的注释起始符号曾被当成注释起点，
// 把紧随其后的 6 行完全合规的 JSDoc 判成「脱块」。**反例**不过 ⇒ 规则失灵（真违约漏网）；
// **正例**不过 ⇒ 规则又在误伤，而误伤会逼着人把合规代码改坏。两者都必须钉住。
// 自证不进全量扫描路径（放在 `const report` 之前早退），故 `npm test` 调它几乎零开销。
if (process.argv.includes('--self-check-jsdoc')) {
  const cases = [
    {
      name: '模板里的注释符号 + 其后合规 JSDoc（旧假红）',
      text: 'const a = `:(exclude)${dir}/**`;\n  /**\n   * ok\n   */\nconst b = 1;\n',
      want: 0,
    },
    {
      name: '模板里的注释符号 + 其后**真违约** JSDoc（必须仍被抓）',
      text: 'const a = `:(exclude)${dir}/**`;\n/**\n* broken\n*/\nconst b = 1;\n',
      want: 2,
    },
    {
      name: '嵌套模板 + 其后合规 JSDoc',
      text: 'const a = `x${`y${z}/**`}`;\n  /**\n   * ok\n   */\nconst b = 1;\n',
      want: 0,
    },
    {
      name: '`${}` 里有对象字面量与注释符号 + 其后合规 JSDoc',
      text: 'const a = `x${JSON.stringify({ k: 1 })}/**`;\n  /**\n   * ok\n   */\nconst b = 1;\n',
      want: 0,
    },
    {
      name: '普通字符串里的注释符号 + 其后合规 JSDoc',
      text: "const a = '/**';\n  /**\n   * ok\n   */\n",
      want: 0,
    },
    {
      name: '无模板的真违约 JSDoc（基线，防规则整体失灵）',
      text: '/**\n* broken\n*/\nconst b = 1;\n',
      want: 2,
    },
  ];
  let selfCheckFailures = 0;
  for (const c of cases) {
    const got = jsdocIndentViolations(c.text);
    const ok = got === c.want;
    if (!ok) selfCheckFailures += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name}: got=${got} want=${c.want}`);
  }
  console.log(`jsdocIndent self-check: ${cases.length - selfCheckFailures}/${cases.length} 例通过`);
  process.exit(selfCheckFailures === 0 ? 0 : 1);
}

const report = [];
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const m = metricsForSource(text, f);
  // JSDoc 续行缩进违约（见 jsdocIndentViolations 的说明）：Prettier 不管 JSDoc 缩进，故单独度量。
  m.jsdocIndent = jsdocIndentViolations(text);
  m.fanIn = fanIn.get(key(f)) || 0;
  m.hot = isHot(f);
  report.push(m);
}

if (process.argv.includes('--delta')) {
  // 增量门禁（pre-commit 用）：仅阻断**本次提交新增**的标准违规，不阻挡历史债务。
  // 口径：对每个暂存 .ts，比较「暂存版本」与「HEAD 版本」的标准度量；
  // 暂存版违规数 > HEAD 版（或新文件存在任何违规）即判失败。
  // 子进程一律走**异步** `execFile` 直起 git，不用 `*Sync` 族、也不经 shell。两条理由都是实测的：
  // ① `execFileSync` / `execSync` 在本机与沙箱环境以 `spawnSync git EBUSY`（Windows 上还表现为
  //    `spawnSync cmd.exe EBUSY`）直接失败，而异步 `spawn`/`execFile` 正常 —— 同步版一旦失败就
  //    落进下面的 catch、**静默跳过并 exit 0**，门禁从此永远"绿"（假绿灯比没有门禁更糟）；
  // ② 直起进程免掉 `-- "*.ts"` 的 shell 引号转义，也不依赖 cmd.exe（受限容器常禁 spawn cmd）。
  const runGit = (gitArgs) =>
    new Promise((resolve, reject) => {
      execFile(
        'git',
        gitArgs,
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        },
      );
    });
  const staged = [];
  try {
    const out = await runGit([
      'diff',
      '--cached',
      '--name-only',
      '--diff-filter=ACMR',
      '--',
      '*.ts',
    ]);
    for (const line of out.split('\n')) {
      const f = line.trim();
      if (f && /\.ts$/.test(f) && !f.endsWith('.d.ts')) staged.push(f);
    }
  } catch (error) {
    // 只有「连 git 都不存在」才是可跳过的情形；其余一律**阻断提交**并打印真实原因。
    // 2026-10-06 复核发现：此处此前无论什么原因都 `exit(0)`（上方注释声称已修，实际只改了文案）——
    // 于是 index.lock 占用 / EBUSY / dubious ownership 这类**真实读取失败**被伪装成"通过"。
    const code = error && typeof error === 'object' ? error.code : undefined;
    if (code === 'ENOENT') {
      console.error('[delta] 未找到 git 可执行文件，跳过增量门禁（该环境无法做 HEAD/暂存比对）。');
      process.exit(0);
    }
    console.error(
      `[delta] 无法获取暂存文件，增量门禁**中止**（fail-closed）：${String(error).slice(0, 400)}`,
    );
    process.exit(1);
  }
  if (staged.length === 0) {
    console.log('[delta] 无暂存 .ts 文件，增量门禁通过。');
    process.exit(0);
  }
  // 仓库根：`git diff --name-only` 的输出**恒为仓库根相对路径**，与本进程 cwd 无关
  // （实测：在 scripts/ 下运行同样打印 `docs/…`）。此前用 `path.resolve(process.cwd(), f)`
  // ⇒ cwd≠仓库根时每个文件都"不可见" ⇒ 全被跳过 ⇒ 零违规通过（2026-10-06 复核发现）。
  let repoRoot = process.cwd();
  try {
    repoRoot = (await runGit(['rev-parse', '--show-toplevel'])).trim() || process.cwd();
  } catch (error) {
    console.error(
      `[delta] 无法解析仓库根（git rev-parse --show-toplevel 失败）：${String(error).slice(0, 200)}，门禁中止。`,
    );
    process.exit(1);
  }
  /**
   * 读 HEAD 版本；新建文件在 HEAD 不存在 ⇒ 返回 `''`（交给 `isNew` 分支，属**预期**路径）。
   * @param f 仓库根相对路径。
   * @returns HEAD 版正文；不存在时为空串。
   */
  const readHead = async (f) => {
    try {
      // stderr 静默：`git show HEAD:<f>` 在新文件上会打印 fatal。
      // `HEAD:src/a b.ts` 这类含空格的 rev 作为**单个 argv** 传递，无需转义。
      return await runGit(['show', `HEAD:${f}`]);
    } catch {
      return '';
    }
  };
  const failures = [];
  for (const f of staged) {
    const abs = path.resolve(repoRoot, f);
    if (!fs.existsSync(abs)) {
      // `--diff-filter=ACMR` 已排除删除 ⇒ 仍缺席只能是**路径口径不对**（见上方 cwd 注释）。
      console.error(
        `[delta] 暂存文件在工作区不可见：${f}（解析为 ${abs}）——路径口径异常，门禁中止。`,
      );
      process.exit(1);
    }
    // 暂存内容**只认 index**：此前 `git show :f` 失败会**回落到工作区文件**去判定 ⇒
    // 「暂存一份违规、再把工作区改干净」即可骗过增量门禁。读 index 失败一律中止。
    let stagedText;
    try {
      stagedText = await runGit(['show', `:${f}`]);
    } catch (error) {
      console.error(
        `[delta] 无法读取暂存内容 :${f}（${String(error).slice(0, 200)}）——不回落到工作区文件，门禁中止。`,
      );
      process.exit(1);
    }
    const headText = await readHead(f);
    if (isHot(abs)) continue; // 热区豁免（与全量审计一致）
    const s = metricsForSource(stagedText, abs);
    const h = headText ? metricsForSource(headText, abs) : null;
    const isNew = !h;
    const cmp = (item, sv, hv, detail) => {
      if (isNew) {
        if (sv > 0) failures.push({ f, item, detail: `新文件存在 ${sv} 处（${detail}）` });
      } else if (sv > hv) {
        failures.push({ f, item, detail: `HEAD ${hv} → 暂存 ${sv}（${detail}）` });
      }
    };
    cmp('var', s.varCount, h?.varCount ?? 0, 'var 声明');
    cmp('any', s.anyCount, h?.anyCount ?? 0, 'any 类型');
    cmp(
      '隐式访问修饰符',
      s.membersNoAccess,
      h?.membersNoAccess ?? 0,
      '缺 public/private/protected',
    );
    cmp('公开成员缺JSDoc', s.publicNoJsdoc, h?.publicNoJsdoc ?? 0, '缺 /** */');
    cmp('导出函数缺JSDoc', s.expFnsNoJsdoc, h?.expFnsNoJsdoc ?? 0, '缺 /** */');
    cmp('导出函数缺返回类型', s.expFnsNoRet, h?.expFnsNoRet ?? 0, '缺 : Type');
    // P4.4（注释门禁化）：细粒度注释缺口只增即红——存量债务不拦，新增一律阻断。
    cmp('类缺JSDoc', s.classesNoJsdoc, h?.classesNoJsdoc ?? 0, '类声明缺 /** 作用 */');
    cmp('方法缺@param', s.paramGap, h?.paramGap ?? 0, '有参方法的 JSDoc 缺 @param');
    cmp('方法缺@returns', s.returnsGap, h?.returnsGap ?? 0, '有返回类型的方法缺 @returns');
    cmp('类字段缺注释', s.fieldGap, h?.fieldGap ?? 0, '属性声明缺注释');
    // JSDoc 续行缩进（新增规则，2026-09-24）：注释脱块「只增即红」，存量已一次性机器修复。
    cmp(
      'JSDoc缩进',
      jsdocIndentViolations(stagedText),
      h ? jsdocIndentViolations(headText) : 0,
      'JSDoc 续行缩进 ≠ 注释起始列 + 1（注释脱离所属块）',
    );
    // 生产级实现标准（CODE_STANDARD §12.2）：占位实现 / 调试残留「只增即红」——
    // 新文件必须完全干净；存量债务（历史 TODO）不拦，但计数会打印供跟踪收口。
    cmp(
      '占位或调试残留',
      s.placeholderCount,
      h?.placeholderCount ?? 0,
      'TODO/FIXME/XXX/HACK、console.log/debug、debugger、not-implemented、裸 @ts-ignore',
    );
    if (!s.nameMatches && (isNew || h?.nameMatches)) {
      failures.push({ f, item: '文件名≠类名', detail: `主类 ${s.mainClass}` });
    }
    if (s.godClass && (isNew || !h?.godClass)) {
      const mm = Math.max(0, ...s.classes.map((c) => c.methods));
      failures.push({ f, item: '上帝类', detail: `${s.lines} 行 / ${mm} 方法` });
    }
  }
  if (failures.length > 0) {
    console.error('\n❌ 编码标准增量门禁失败（' + failures.length + ' 处新增违规）：');
    for (const b of failures) console.error(`  - ${b.f}: [${b.item}] ${b.detail}`);
    console.error(
      '\n  本门禁只阻断「本次提交新增」的违规，不阻挡既有历史债务；请就地修掉上述项后再提交。',
    );
    process.exit(1);
  } else {
    console.log('✅ 编码标准增量门禁通过：本次提交未新增标准违规。');
    process.exit(0);
  }
}

const uniq = (a) => [...new Set(a)];
const sum = (a, k) => a.reduce((s, x) => s + x[k], 0);

console.log('=== SUMMARY (' + report.length + ' files) ===');
console.log(
  'var: ' +
    sum(report, 'varCount') +
    '   any: ' +
    sum(report, 'anyCount') +
    '   static: ' +
    sum(report, 'staticCount') +
    '   占位/调试残留: ' +
    sum(report, 'placeholderCount') +
    '（CODE_STANDARD §12.2，只增即红）',
);
const totalTopFns = report.reduce((s, r) => s + r.topFns.length, 0);
const totalExportedFns = report.reduce((s, r) => s + r.topFns.filter((x) => x.exported).length, 0);
const fnsNoJsdoc = report.reduce(
  (s, r) => s + r.topFns.filter((x) => x.exported && !x.jsdoc).length,
  0,
);
const fnsNoRet = report.reduce(
  (s, r) => s + r.topFns.filter((x) => x.exported && !x.ret).length,
  0,
);
console.log(
  'top-level fns: ' +
    totalTopFns +
    ' (exported ' +
    totalExportedFns +
    ', exported w/o JSDoc ' +
    fnsNoJsdoc +
    ', exported w/o return type ' +
    fnsNoRet +
    ')',
);
console.log(
  'class members w/o explicit access modifier: ' +
    sum(report, 'membersNoAccess') +
    ' / ' +
    sum(report, 'membersTotal'),
);
console.log(
  'public members w/o JSDoc: ' + sum(report, 'publicNoJsdoc') + ' / ' + sum(report, 'publicTotal'),
);
console.log('JSDoc 续行缩进违约（注释脱块）: ' + sum(report, 'jsdocIndent'));

// 口径（2026-09-12 修正）：「上帝类」是**类**的属性，故只统计**含类**的文件。
// 口径（D7，2026-09-13 修正）：行数判据用 codeLines（剔注释/空行），不惩罚补文档——见 metricsForSource 内留档。
// 无类的纯函数模块按 check.mjs 的文件上限（800 行，决策 D1）判定，不在此重复计数——
// 否则「一文件一类」达标、函数范式的模块会被误报成上帝类（实测已误报 layeredCodeGraph）。
console.log('\n=== GOD CLASSES (含类文件 codeLines>500 OR class >25 methods) ===');
let classlessLong = 0;
for (const r of report.slice().sort((a, b) => b.codeLines - a.codeLines)) {
  const maxM = Math.max(0, ...r.classes.map((c) => c.methods));
  if (r.classes.length === 0) {
    if (r.lines > 500) classlessLong += 1; // 仅计数，不属「上帝类」
    continue;
  }
  if (r.codeLines > 500 || maxM > 25)
    console.log(
      r.codeLines +
        ' lines / ' +
        maxM +
        ' max-methods / ' +
        r.classes.length +
        ' class  ' +
        (r.hot ? '[HOT] ' : '') +
        r.file,
    );
}
if (classlessLong > 0)
  console.log(
    '(' + classlessLong + ' 个 >500 行的**无类**模块已按 D1 的 800 行上限口径排除，不计为上帝类)',
  );

console.log(
  '\n=== FILES WHERE MAIN CLASS NAME != FILENAME (' +
    report.filter((r) => !r.nameMatches).length +
    ') ===',
);
for (const r of report.filter((r) => !r.nameMatches))
  console.log(r.mainClass + '  <->  ' + r.file + (r.hot ? '  [HOT]' : ''));

console.log('\n=== STATIC HEAVY (>=4 statics) ===');
for (const r of report
  .slice()
  .sort((a, b) => b.staticCount - a.staticCount)
  .filter((r) => r.staticCount >= 4))
  console.log(r.staticCount + ' static  ' + r.file + (r.hot ? '  [HOT]' : ''));

console.log('\n=== HIGH FAN-IN (>8 importers) TOP 30 ===');
for (const r of report
  .slice()
  .sort((a, b) => b.fanIn - a.fanIn)
  .slice(0, 30))
  console.log(r.fanIn + ' importers  ' + r.file);

console.log('\n=== MULTI-EXPORT MODULES (>=3 exported classes, one-class-per-file candidates) ===');
for (const r of report.filter((r) => r.classes.filter((c) => c.exported).length >= 3))
  console.log(
    r.classes
      .filter((c) => c.exported)
      .map((c) => c.name)
      .join(',') +
      '  ->  ' +
      r.file,
  );

if (process.argv.includes('--jsdoc')) {
  const ranked = report
    .filter((r) => r.missingJsdoc.length > 0 && !r.hot)
    .sort((a, b) => b.missingJsdoc.length - a.missingJsdoc.length);
  console.log('\n=== MISSING JSDoc ON PUBLIC MEMBERS (per file, top 40) ===');
  for (const r of ranked.slice(0, 40)) {
    console.log(
      r.missingJsdoc.length +
        '  ' +
        r.file +
        '   [' +
        r.missingJsdoc.map((m) => m.name).join(', ') +
        ']',
    );
  }
}

if (process.argv.includes('--maturity')) {
  // T0 · 成熟度治理门禁（docs/archive/TECH_DIRECTION_SYNTHESIS_2026-09-12.md）。
  // 契约：@maturity L0|L1|L2|L3 — <判据>   +   @maturityEvidence <测试文件>（L2/L3 必填且须存在）。
  // 目的：把「命名好听」与「有机制/有定理」机械分开——声称 L2/L3 却无测试者，一律阻断。
  const LEVELS = ['L0', 'L1', 'L2', 'L3'];
  const decls = [];
  const bad = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const lm = text.match(/@maturity\s+([A-Za-z0-9]+)\s*(?:[—-]\s*(.*))?/);
    if (!lm) continue;
    const level = lm[1];
    const note = (lm[2] ?? '').trim();
    // 证据可声明多条（英文逗号分隔）——逐条做存在性校验，任一缺失即阻断。
    const em = text.match(/@maturityEvidence[ \t]+([^\n]*)/);
    const evidenceList = em
      ? em[1]
          .replace(/\*\/\s*$/, '')
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p.length > 0)
      : [];
    const evidence = evidenceList[0] ?? null;
    const file = f.split(path.sep).join('/');
    const rec = { file, level, note, evidence, evidenceList };
    decls.push(rec);
    if (!LEVELS.includes(level)) {
      bad.push({ ...rec, why: `等级 '${level}' 非法（须为 ${LEVELS.join('/')}）` });
    } else if ((level === 'L2' || level === 'L3') && evidenceList.length === 0) {
      bad.push({
        ...rec,
        why: `${level} 必须提供 @maturityEvidence 指向测试文件（无测试的声明一律降级）`,
      });
    } else {
      const missing = evidenceList.filter((p) => !fs.existsSync(path.resolve(process.cwd(), p)));
      if (missing.length > 0) {
        bad.push({ ...rec, why: `证据文件不存在：${missing.join(', ')}` });
      } else if (level === 'L2' || level === 'L3') {
        // 2026-10-01 审计加固：原先只做 `fs.existsSync` —— `@maturityEvidence package.json`
        // 也能让 L3 通过。现在证据必须是**含断言的测试文件**（tests/** 且引用 node:assert），
        // 否则「说 L3 必须有测试」只是名义约束。
        const notTests = evidenceList.filter((p) => {
          const rel = p.split(path.sep).join('/');
          if (!/(^|\/)tests\//.test(rel)) return true;
          const text = fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
          return !/(from\s+['"]node:assert|require\(['"]node:assert|\bassert\.)/.test(text);
        });
        if (notTests.length > 0) {
          bad.push({
            ...rec,
            why: `${level} 证据须是含断言的测试文件（tests/** 且引用 node:assert）：${notTests.join(', ')}`,
          });
        }
      }
    }
  }

  const byLevel = {};
  for (const d of decls) (byLevel[d.level] ??= []).push(d);
  console.log('\n=== MATURITY DECLARATIONS (' + decls.length + ' 个引擎已声明) ===');
  for (const lv of LEVELS) {
    const list = byLevel[lv] ?? [];
    console.log(`  ${lv}: ${list.length}`);
    for (const d of list) {
      const ev = (d.evidenceList ?? []).join(', ');
      console.log(`      ${d.file}${ev ? '   <- ' + ev : ''}`);
    }
  }
  // 报告级：证据是否「名义的」（测试文件未真正 import 该模块，仅提及名字）。
  // 例：`const bm25 = [{id:'b'}]` 这种桩数据也会命中名字，但不构成覆盖。
  const nominal = decls.filter((d) => {
    const existing = (d.evidenceList ?? (d.evidence ? [d.evidence] : [])).filter((p) =>
      fs.existsSync(path.resolve(process.cwd(), p)),
    );
    if (existing.length === 0) return false;
    const base = path.basename(d.file).replace(/\.ts$/, '');
    const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const rel of existing) {
      const p = path.resolve(process.cwd(), rel);
      const text = fs.readFileSync(p, 'utf8');
      if (new RegExp(`${esc}\\.js`).test(text)) return false; // 直接 import 了本模块
      // 经 re-export 导入也算覆盖（如测试 import 适配器，适配器再 `export { X } from './x.js'`）。
      const reExportOf = new RegExp(`export\\s*\\{[^}]*\\}\\s*from\\s*['"][^'"]*${esc}\\.js['"]`);
      const specRe = /from\s+['"]([^'"]+\.js)['"]/g;
      let m;
      while ((m = specRe.exec(text)) !== null) {
        // 测试按 ESM 规范 import '.js'，磁盘上实际是 '.ts'——解析后须换后缀才能命中。
        const target = path.resolve(path.dirname(p), m[1]).replace(/\.js$/, '.ts');
        if (!fs.existsSync(target)) continue;
        if (reExportOf.test(fs.readFileSync(target, 'utf8'))) return false;
      }
    }
    return true;
  });
  // 2026-10-01 审计加固：「名义证据」原先只 console.log（连形式合规都算不上）。
  // 测试文件未真正 import 引擎模块 ⇒ 证据不构成覆盖，直接判失败。
  if (nominal.length > 0) {
    console.error(
      '\n❌ 成熟度门禁失败：名义证据（测试文件未真正 import 引擎模块）× ' + nominal.length,
    );
    for (const d of nominal) console.error(`  - ${d.file}  <-  ${d.evidence}`);
    process.exitCode = 1;
  }

  if (bad.length > 0) {
    console.error('\n❌ 成熟度门禁失败（' + bad.length + ' 处）：');
    for (const b of bad) console.error(`  - ${b.file}: ${b.why}`);
    process.exitCode = 1;
  } else if (decls.length === 0) {
    // **0 项声明 = 通过** 是假绿（2026-10-06 第五十七轮 ③）：本门禁是"存量冻结 + L2/L3 有证据"，
    // 解析口径一旦失效（注释格式变了、扫描目录挪了），`decls` 为空会让它无条件报"通过"，
    // 而输出里的句子还是写死的"L2/L3 均有存在性证据"。
    console.error(
      '\n❌ 成熟度门禁失败：0 项声明 ⇒ 解析口径失效（不是"没有引擎需要声明"）。' +
        ' 本仓当前应有 85 项左右；若确实全部删除，请同步修订本门禁。',
    );
    process.exitCode = 1;
  } else {
    console.log('\n✅ 成熟度门禁通过：' + decls.length + ' 项声明，L2/L3 均有存在性证据。');
  }
}

if (process.argv.includes('--p02')) {
  // P0.2 扩展度量：注释细粒度覆盖 + core→adapters 违规 + 模块级 new 清单。
  // 口径来源：docs/REFACTOR_BOARD_2026-09-12.md §1.2 / §1.3。数字进 §4。
  let cm = null;
  for (const f of files) {
    const r = collectCommentMetrics(fs.readFileSync(f, 'utf8'), f);
    if (!cm) cm = { ...r };
    else for (const k of Object.keys(r)) cm[k] += r[k];
  }
  const pParam = cm.methodsWithParams
    ? (cm.methodsWithParamsParam / cm.methodsWithParams) * 100
    : 0;
  const pRet = cm.methodsWithRet ? (cm.methodsWithRetReturns / cm.methodsWithRet) * 100 : 0;
  const pField = cm.propsTotal ? (cm.propsWithJsdoc / cm.propsTotal) * 100 : 0;
  console.log('\n=== P0.2 注释细粒度覆盖（类方法 + 字段，AST 实测） ===');
  console.log(
    `  有参方法 @param 覆盖     : ${cm.methodsWithParamsParam} / ${cm.methodsWithParams}  (${pParam.toFixed(1)}%)`,
  );
  console.log(
    `  有返回方法 @returns 覆盖  : ${cm.methodsWithRetReturns} / ${cm.methodsWithRet}  (${pRet.toFixed(1)}%)`,
  );
  console.log(
    `  类字段注释覆盖           : ${cm.propsWithJsdoc} / ${cm.propsTotal}  (${pField.toFixed(1)}%)`,
  );
  console.log(`  （类方法总数 ${cm.methodsTotal}，含私有/保护；排除构造器）`);

  const ca = [];
  for (const [from, targets] of outgoing) {
    if (!from.startsWith('core/')) continue;
    for (const t of targets) if (t.startsWith('adapters/')) ca.push(`${from}  ->  ${t}`);
  }
  console.log(`\n=== P0.2 core→adapters 违规 (${ca.length}) ===`);
  ca.forEach((e) => console.log('  ' + e));

  const VALUE_TYPES = new Set([
    'Set',
    'Map',
    'WeakMap',
    'WeakSet',
    'Array',
    'Float64Array',
    'Float32Array',
    'Uint8Array',
    'Uint16Array',
    'Uint32Array',
    'Int8Array',
    'Int16Array',
    'Int32Array',
    'BigInt64Array',
    'Date',
    'URL',
    'URLSearchParams',
    'Promise',
    'AbortController',
    'AsyncLocalStorage',
    'RegExp',
    'Bm25Index',
    'TextDecoder',
    'LspJsonRpcConnection',
    'Error',
    'TypeError',
    'RangeError',
    'SyntaxError',
    'Buffer',
  ]);
  const moduleNew = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const re = /(?:^|\n)(export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*new\s+([A-Za-z0-9_]+)/gm;
    let m;
    while ((m = re.exec(text))) {
      const cls = m[3];
      const exported = !!m[1];
      const stateful = !VALUE_TYPES.has(cls);
      moduleNew.push({
        file: f.split(path.sep).join('/'),
        name: m[2],
        cls,
        exported,
        stateful,
      });
    }
  }
  const stateful = moduleNew.filter((x) => x.stateful);
  const exportedStateful = stateful.filter((x) => x.exported);
  // 口径对齐 docs/REFACTOR_BOARD §1.3「隐式单例 18」= 模块级「导出」状态化单例（export const x = new Class）。
  // 其余为：非导出模块级单例（16）+ 值对象/集合常量（8）——同属模块级有状态 new，P2 一并清偿。
  console.log(
    `\n=== P0.2 模块级 new 清单 (${moduleNew.length} 处；状态化 ${stateful.length} / 其中导出单例 ${exportedStateful.length} / 值类型 ${moduleNew.length - stateful.length}) ===`,
  );
  moduleNew
    .slice()
    .sort((a, b) =>
      a.stateful === b.stateful
        ? a.exported === b.exported
          ? 0
          : a.exported
            ? -1
            : 1
        : a.stateful
          ? -1
          : 1,
    )
    .forEach((x) =>
      console.log(
        `  ${x.stateful ? (x.exported ? '*' : '+') : ' '} ${x.file}  ::  ${x.name} = new ${x.cls}()`,
      ),
    );
  console.log('  (* 导出状态化单例 / + 非导出模块级单例 / 空格 值对象·集合常量)');
}

if (process.argv.includes('--html')) {
  console.log('\n=== HOT-ZONE EXEMPT MEMBERS ONLY (should be the residual) ===');
  for (const r of report.filter((x) => x.hot && x.membersNoAccess > 0))
    console.log(r.membersNoAccess + '  ' + r.file);
}

console.log('\n=== LOW-FAN-IN NON-HOT FILES (fanIn<=1, safe first batch) ===');
for (const r of report.filter((r) => !r.hot && r.fanIn <= 1).sort((a, b) => a.lines - b.lines))
  console.log('lines ' + r.lines + ' fanIn ' + r.fanIn + '  ' + r.file);
