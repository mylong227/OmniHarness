/**
 * 技能包静态权限扫描（商业化路线图 **H1** 分级的第一条腿）。
 *
 * ## 它扫什么
 *
 * 把包内源码/配置当**词法**输入，按规则表找出"危险能力"的**使用证据**：起进程、写文件、
 * 出网、动态求值、读环境变量、读写包外绝对路径。每条发现带**严重级**与**可读理由**，
 * 并归到**能力名**（`process` / `fs-write` / `network` / `eval` / `env` / `abs-path`），
 * 供"声明 vs 实际"的差异测试比对。
 *
 * ## 诚实边界（写进模块而不是藏在 README）
 *
 * 这是**词法扫描**，不是 AST 分析：字符串拼接、`globalThis['ev'+'al']`、编码后再解等手法可以绕过。
 * 因此它在分级里**只降级、不升级**——扫不到不等于安全（`clean` 只表示"没扫出证据"），
 * 而扫到了就一定是证据。这条不对称是本模块唯一重要的性质。
 *
 * @maturity L1 — 六类能力识别 / 注释与字符串里的"提及"不算证据 / 严重级归并 / 有界 判据钉死
 * @maturityEvidence tests/unit/packGrader.test.ts
 */

/** 能力名（声明与实际比对的最小单位）。 */
export type PackCapability =
  'process' | 'fs-write' | 'network' | 'eval' | 'env' | 'abs-path' | 'native-addon';

/** 严重级（`critical` ⇒ 直接 C；`high` ⇒ 需声明覆盖；`medium` ⇒ 需声明覆盖但只降一档）。 */
export type FindingSeverity = 'critical' | 'high' | 'medium';

/** 一条发现。 */
export interface PackFinding {
  /** 能力名。 */
  readonly capability: PackCapability;
  /** 严重级。 */
  readonly severity: FindingSeverity;
  /** 命中文件（包内相对路径）。 */
  readonly file: string;
  /** 行号（1 基；词法扫描的近似定位，够用于 code review）。 */
  readonly line: number;
  /** 可读理由（进市场详情页与审计）。 */
  readonly reason: string;
  /** 命中的代码片段（截断，便于一眼确认）。 */
  readonly snippet: string;
}

/** 扫描结论。 */
export interface PackScanReport {
  /** 扫过的文件数。 */
  readonly scannedFiles: number;
  /** 逐条发现（按文件、行号排序，确定性）。 */
  readonly findings: readonly PackFinding[];
  /** 命中的能力集合（差异测试的"实际"侧）。 */
  readonly capabilities: readonly PackCapability[];
  /** 是否扫出 `critical`（分级里一票否决）。 */
  readonly hasCritical: boolean;
}

/** 一条规则。 */
interface ScanRule {
  /** 能力名。 */
  readonly capability: PackCapability;
  /** 严重级。 */
  readonly severity: FindingSeverity;
  /** 匹配模式（作用在**已去注释**的文本上）。 */
  readonly pattern: RegExp;
  /** 理由。 */
  readonly reason: string;
  /**
   * 是否允许命中**落在字符串字面量内**。
   *
   * 为什么需要这个开关：`require("child_process")` 的模块名本身就在字符串里——一律遮蔽字符串会让
   * **最该抓的证据**（导入危险模块）漏掉；而 `eval(` / `exec(` 这类**调用**只在代码里出现，
   * 字符串里出现属于"提及"（文档、错误消息），不该算证据。故按规则区分，而不是全局一刀切。
   */
  readonly stringOk: boolean;
}

/** 规则表（唯一出处；新增一条即多一条判据）。 */
const RULES: readonly ScanRule[] = [
  // 起进程：能跑任意命令 ⇒ 与"安装一个技能包"的授权范围完全不同级。
  {
    capability: 'process',
    severity: 'high',
    pattern: /\b(child_process|execSync|spawnSync|execFileSync|\bspawn\s*\(|\bexec\s*\()/,
    reason: '起进程 / 执行外部命令（可绕过一切包内约束）',
    stringOk: true,
  },
  // 写文件：包能改工作区就是"数据面"风险。
  {
    capability: 'fs-write',
    severity: 'high',
    pattern:
      /\b(writeFile|writeFileSync|appendFile|appendFileSync|rmSync|unlinkSync|mkdirSync|renameSync)\b/,
    reason: '写 / 删 / 改文件系统',
    stringOk: false,
  },
  // 出网：数据外流与 SSRF 面。
  {
    capability: 'network',
    severity: 'high',
    pattern: /\b(fetch\s*\(|https?\.request|https?\.get|net\.connect|WebSocket\s*\()/,
    reason: '网络出站（数据外流 / SSRF 面）',
    stringOk: false,
  },
  // 动态求值：静态扫描对它天然无力，故一旦出现就是"不能评为 A"的硬信号。
  {
    capability: 'eval',
    severity: 'critical',
    pattern: /\b(eval\s*\(|new\s+Function\s*\()/,
    reason: '动态求值：静态扫描不可覆盖其行为（可构造任意代码）',
    stringOk: false,
  },
  // 读环境变量：凭据泄露面。
  {
    capability: 'env',
    severity: 'medium',
    pattern: /\bprocess\.env\b/,
    reason: '读取环境变量（可能触及凭据）',
    stringOk: false,
  },
  // 包外绝对路径：越过"包内自包含"的边界。
  // 模式**不能要求前置引号**：字符串遮蔽会把引号抹成空格，故用"行首或非词字符 + /"来定位。
  {
    capability: 'abs-path',
    severity: 'medium',
    pattern: /(?:^|[^\w])\/(?:etc|root|home|var|usr)\//,
    reason: '引用包外系统绝对路径（越过自包含边界）',
    stringOk: true,
  },
  // 原生扩展：二进制不在词法扫描与沙箱 JS 语义的覆盖范围内。
  // 同样不能依赖引号（字符串遮蔽会抹掉引号）：用 `.node` 词边界定位。
  {
    capability: 'native-addon',
    severity: 'critical',
    pattern: /\.node\b|node-gyp|binding\.gyp/,
    reason: '原生扩展：二进制行为不受本仓扫描与沙箱约束',
    stringOk: true,
  },
];

/** 参与扫描的扩展名（其余文件只统计不解析内容）。 */
const SCANNABLE = /\.(js|mjs|cjs|ts|mts|cts|json|sh|ps1|py)$/i;

/** 技能包静态扫描器。 */
export class PackStaticScanner {
  private constructor() {}

  /**
   * 扫描一组"包内文件"。
   * @param files 包内文件（相对路径 → 文本内容）
   * @returns 扫描结论
   */
  public static scan(files: ReadonlyMap<string, string>): PackScanReport {
    const findings: PackFinding[] = [];
    let scannedFiles = 0;
    for (const [file, text] of files) {
      // 文件名本身也是证据：`binding.gyp` / `*.node` 的存在就说明包内含原生扩展，
      // 而其**行为**不在词法扫描与沙箱 JS 语义的覆盖范围内（与文件内容是否可扫描无关）。
      if (/(^|\/)binding\.gyp$|\.node$/i.test(file)) {
        findings.push({
          capability: 'native-addon',
          severity: 'critical',
          file,
          line: 1,
          reason: '包内含原生扩展文件（二进制行为不受本仓扫描与沙箱约束）',
          snippet: file,
        });
      }
      if (!SCANNABLE.test(file)) continue;
      scannedFiles += 1;
      findings.push(...PackStaticScanner.scanOne(file, text));
    }
    findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
    const capabilities = [...new Set(findings.map((f) => f.capability))].sort();
    return {
      scannedFiles,
      findings,
      capabilities,
      hasCritical: findings.some((f) => f.severity === 'critical'),
    };
  }

  /**
   * 扫描单个文件。
   * @param file 包内相对路径
   * @param text 文件内容
   * @returns 发现列表（按行号升序）
   */
  private static scanOne(file: string, text: string): readonly PackFinding[] {
    const analysis = PackStaticScanner.analyze(text);
    const found: PackFinding[] = [];
    for (const rule of RULES) {
      for (const line of analysis) {
        const match = rule.pattern.exec(line.noComments);
        if (match === null) continue;
        // 字符串内的命中：只有 `stringOk` 的规则才算证据（其余属"提及"，算误报）。
        if (
          !rule.stringOk &&
          PackStaticScanner.insideString(line.spans, match.index, match[0].length)
        ) {
          continue;
        }
        found.push({
          capability: rule.capability,
          severity: rule.severity,
          file,
          line: line.number,
          reason: rule.reason,
          snippet: line.original.trim().slice(0, 120),
        });
      }
    }
    return found;
  }

  /**
   * 逐行分析：给出**去注释**文本、原文、以及字符串区间（列位与原文一致）。
   * @param text 原文
   * @returns 行分析结果
   */
  private static analyze(text: string): readonly {
    readonly number: number;
    readonly original: string;
    readonly noComments: string;
    readonly spans: readonly (readonly [number, number])[];
  }[] {
    const lines = text.split('\n');
    const result: {
      readonly number: number;
      readonly original: string;
      readonly noComments: string;
      readonly spans: readonly (readonly [number, number])[];
    }[] = [];
    let inBlock = false;
    for (let index = 0; index < lines.length; index += 1) {
      const original = lines[index] ?? '';
      const chars = [...original];
      const spans: (readonly [number, number])[] = [];
      let quote: string | undefined;
      let spanStart = -1;
      for (let i = 0; i < chars.length; i += 1) {
        const char = chars[i] ?? '';
        const next = chars[i + 1] ?? '';
        if (inBlock) {
          chars[i] = ' ';
          if (char === '*' && next === '/') {
            chars[i + 1] = ' ';
            i += 1;
            inBlock = false;
          }
          continue;
        }
        if (quote !== undefined) {
          if (char === '\\') {
            chars[i] = ' ';
            if (next !== '') chars[i + 1] = ' ';
            i += 1;
            continue;
          }
          if (char === quote) {
            chars[i] = ' ';
            spans.push([spanStart, i]);
            quote = undefined;
            continue;
          }
          continue; // 字符串内容原样保留（供 stringOk 规则匹配）。
        }
        if (char === '/' && next === '/') {
          for (let j = i; j < chars.length; j += 1) chars[j] = ' ';
          break;
        }
        if (char === '/' && next === '*') {
          chars[i] = ' ';
          chars[i + 1] = ' ';
          i += 1;
          inBlock = true;
          continue;
        }
        if (char === '"' || char === "'" || char === '`') {
          quote = char;
          chars[i] = ' ';
          spanStart = i;
        }
      }
      if (quote !== undefined) spans.push([spanStart, chars.length - 1]);
      result.push({ number: index + 1, original, noComments: chars.join(''), spans });
    }
    return result;
  }

  /**
   * 判断某次命中是否落在字符串区间内。
   * @param spans 该行的字符串区间（闭区间）
   * @param start 命中起点
   * @param length 命中长度
   * @returns 是否完全落在某个字符串内
   */
  private static insideString(
    spans: readonly (readonly [number, number])[],
    start: number,
    length: number,
  ): boolean {
    const end = start + length - 1;
    return spans.some(([from, to]) => start >= from && end <= to);
  }
}
