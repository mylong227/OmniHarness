/**
 * 无第三方依赖 repo-map 符号抽取器（#M2 上下文图压缩前置）。
 *
 * 设计约束：运行时无第三方依赖（与全工程铁律一致），不引入 tree-sitter。
 * 用语言感知的正则抽取高信号符号（函数/类/接口/类型/常量/方法），
 * 产出紧凑的「结构大纲」供上下文检索与压缩使用。
 *
 * 这不是 AST 的完美替代品，但在「让模型快速定位符号所在文件与签名」这件事上，
 * 比「整文件硬塞」或「裸 grep 整文件」成本低一个数量级，且完全可复现。
 */

/**
 * RepoMap —— 由本文件原顶层函数归并而来（每个方法对应一个原函数，语义与签名逐字保留）。
 */
export class RepoMap {
  /**
   * 从单文件内容抽取符号。relPath 用于语言判断与回填。
   * @param relPath 相对仓库根的文件路径（决定走 TS 还是 Python 规则）。
   * @param content 文件全文。
   * @returns 抽取出的符号节点列表（按行序）。
   */
  public static extractSymbols(relPath: string, content: string): SymbolNode[] {
    const lines = content.split('\n');
    const rules = relPath.endsWith('.py') ? PY_RULES : TS_RULES;
    const nodes: SymbolNode[] = [];

    for (let i = 0; i < lines.length; i += 1) {
      const lineText = lines[i] ?? '';
      for (const rule of rules) {
        const m = rule.pattern.exec(lineText);
        if (m !== null && m[1] !== undefined) {
          nodes.push({
            file: relPath,
            line: i + 1,
            kind: rule.kind,
            name: m[1],
            signature: lineText.trim().slice(0, 120),
          });
          break;
        }
      }
      if (!relPath.endsWith('.py')) {
        const mm = METHOD_RULE.exec(lineText);
        if (mm !== null && mm[1] !== undefined) {
          // 过滤明显非方法的噪音（如箭头函数赋值已归入 const）。
          const trimmed = lineText.trim();
          if (!trimmed.startsWith('const ') && !trimmed.startsWith('let ')) {
            nodes.push({
              file: relPath,
              line: i + 1,
              kind: 'method',
              name: mm[1],
              signature: trimmed.slice(0, 120),
            });
          }
        }
      }
    }
    return nodes;
  }

  /**
   * 生成紧凑结构大纲（按文件分组）。用于作为 repo-map 的「场拓扑」表示。
   * @param nodes 符号节点列表。
   * @returns 按文件分组的纯文本大纲。
   */
  public static outlineText(nodes: readonly SymbolNode[]): string {
    const byFile = new Map<string, SymbolNode[]>();
    for (const n of nodes) {
      const arr = byFile.get(n.file);
      if (arr === undefined) {
        byFile.set(n.file, [n]);
      } else {
        arr.push(n);
      }
    }
    const parts: string[] = [];
    for (const [file, syms] of byFile) {
      parts.push(`📄 ${file}`);
      for (const s of syms) {
        parts.push(`   L${s.line} ${s.kind} ${s.name}`);
      }
    }
    return parts.join('\n');
  }
}

/** 符号种类。 */
export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'const'
  | 'method'
  /** import / from-import 声明（Python 路专用）：模块名进符号索引，拓宽候选池。 */
  | 'import';

/** 单个抽取出的符号节点。 */
export interface SymbolNode {
  /** 相对仓库根的路径。 */
  readonly file: string;
  /** 1-based 行号。 */
  readonly line: number;
  readonly kind: SymbolKind;
  readonly name: string;
  /** 紧凑签名（首行截取到一定长度）。 */
  readonly signature: string;
}

interface KindRule {
  readonly kind: SymbolKind;
  // 捕获组 1 = 名称；匹配后取该行作为签名。
  readonly pattern: RegExp;
}

const TS_RULES: readonly KindRule[] = [
  {
    kind: 'function',
    pattern: /^\s*(?:export\s+(?:default\s+)?(?:async\s+)?)?function\s+([A-Za-z_$][\w$]*)/,
  },
  { kind: 'class', pattern: /^\s*(?:export\s+(?:default\s+)?)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'interface', pattern: /^\s*(?:export\s+(?:default\s+)?)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'type', pattern: /^\s*(?:export\s+(?:default\s+)?)?type\s+([A-Za-z_$][\w$]*)\s*=/ },
  {
    kind: 'const',
    pattern: /^\s*(?:export\s+(?:default\s+)?)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/,
  },
];

/**
 * Python 抽取规则（2026-10-02 能力升级，能力审计 C6）：
 *  - `(?:async\s+)?def`：此前 `async def` **完全抽不到**（现代 Python 协程主力形态）；
 *  - 缩进允许（`^\s*`）：类方法同 function 通道抽出；
 *  - `import` / `from X import`：模块名进符号索引——查询提到模块名（如 `models`、`conftest`）
 *    时文件可入候选池。这是跨仓（Python 仓为主）召回差的直接修复点：审计实测 45.6% 查询的
 *    GT 文件「任何名次都不可达」，池子缺源头符号是原因之一。
 */
const PY_RULES: readonly KindRule[] = [
  { kind: 'function', pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/ },
  { kind: 'class', pattern: /^\s*class\s+([A-Za-z_][\w]*)\s*\(?/ },
  { kind: 'import', pattern: /^\s*import\s+([A-Za-z_][\w.]*)/ },
  { kind: 'import', pattern: /^\s*from\s+\.?([A-Za-z_][\w.]*)\s+import\s/ },
  { kind: 'import', pattern: /^\s*from\s+\.+\s+import\s+([A-Za-z_][\w]*)/ },
];

const METHOD_RULE =
  /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/;
