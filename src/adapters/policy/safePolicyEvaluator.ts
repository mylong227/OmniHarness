/**
 * 安全策略求值器（#S34）：纯递归下降解析 + 求值，零代码执行（绝无 eval/Function），fail-closed。
 *
 * 对标 codex-rs/execpolicy 的「规则 → 决策」意图，但以安全子集实现：表达式只允许
 * 标识符/字面量/比较/布尔组合，解析失败或未知标识符一律视为 false（绝不让规则「意外通过」）。
 */
import type {
  PolicyDecision,
  PolicyEffect,
  PolicyFacts,
  PolicyPort,
  PolicyRule,
} from '../../ports/runtime/policy.js';

// ---------- 词法 ----------

type Tok =
  | { k: 'lparen' }
  | { k: 'rparen' }
  | { k: 'op'; v: '==' | '!=' | '~' | 'in' }
  | { k: 'and' }
  | { k: 'or' }
  | { k: 'not' }
  | { k: 'str'; v: string }
  | { k: 'num'; v: number }
  | { k: 'bool'; v: boolean }
  | { k: 'ident'; v: string };

// ---------- 语法（递归下降） ----------

type Ast =
  | { t: 'or'; l: Ast; r: Ast }
  | { t: 'and'; l: Ast; r: Ast }
  | { t: 'not'; e: Ast }
  | { t: 'cmp'; op: '==' | '!=' | '~' | 'in'; l: Ast; r: Ast }
  | { t: 'val'; v: string | number | boolean }
  | { t: 'ident'; name: string };

/** 递归下降解析器：把策略表达式 token 序列解析为 AST（纯语法层，不涉及事实求值）。 */
class Parser {
  /** 当前解析游标位置（已消费的 token 数）。 */
  private pos = 0;
  public constructor(
    /** 待解析的 token 序列（由 tokenize 产出）。 */
    private readonly toks: Tok[],
  ) {}

  /** 预览当前 token（不消费）。
   * @returns 游标处 token；已到末尾时为 undefined。
   */
  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }
  /** 消费并返回当前 token。
   * @returns 游标处 token（游标前移一位）；已到末尾时为 undefined。
   */
  private next(): Tok | undefined {
    return this.toks[this.pos++];
  }

  /** 解析入口：token 序列 → 表达式 AST；空表达式解析为恒真字面量，存在多余 token 时抛错。
   * @returns 表达式 AST（or → and → not → 比较的优先级结构）。
   */
  public parse(): Ast {
    if (this.toks.length === 0) return { t: 'val', v: true }; // 空表达式 = 恒真
    const e = this.parseOr();
    if (this.pos !== this.toks.length) throw new Error('表达式存在多余 token');
    return e;
  }

  /** 解析 or 层（最低优先级，左结合）。
   * @returns or 表达式 AST；无 or 时为下层 and 结果。
   */
  private parseOr(): Ast {
    let left = this.parseAnd();
    while (this.peek()?.k === 'or') {
      this.next();
      left = { t: 'or', l: left, r: this.parseAnd() };
    }
    return left;
  }

  /** 解析 and 层（左结合）。
   * @returns and 表达式 AST；无 and 时为下层 not 结果。
   */
  private parseAnd(): Ast {
    let left = this.parseNot();
    while (this.peek()?.k === 'and') {
      this.next();
      left = { t: 'and', l: left, r: this.parseNot() };
    }
    return left;
  }

  /** 解析 not 层（前缀一元，可叠套）。
   * @returns not 表达式 AST；无 not 时为下层比较结果。
   */
  private parseNot(): Ast {
    if (this.peek()?.k === 'not') {
      this.next();
      return { t: 'not', e: this.parseNot() };
    }
    return this.parseComparison();
  }

  /** 解析比较层（== / != / ~ / in，双侧操作数）。
   * @returns 比较表达式 AST；当前 token 不是比较运算符时为单个操作数节点。
   */
  private parseComparison(): Ast {
    const left = this.parseOperand();
    const tok = this.peek();
    if (tok?.k === 'op') {
      this.next();
      const right = this.parseOperand();
      return { t: 'cmp', op: tok.v, l: left, r: right };
    }
    return left;
  }

  /** 解析原子操作数：括号子表达式、字面量或标识符。
   * @returns 操作数 AST 节点；表达式意外结束或 token 非法时抛错。
   */
  private parseOperand(): Ast {
    const tok = this.peek();
    if (tok === undefined) throw new Error('表达式意外结束');
    if (tok.k === 'lparen') {
      this.next();
      const e = this.parseOr();
      if (this.peek()?.k !== 'rparen') throw new Error('缺少右括号');
      this.next();
      return e;
    }
    if (tok.k === 'str' || tok.k === 'num' || tok.k === 'bool') {
      this.next();
      return { t: 'val', v: tok.v };
    }
    if (tok.k === 'ident') {
      this.next();
      return { t: 'ident', name: tok.v };
    }
    if (
      tok.k === 'op' ||
      tok.k === 'and' ||
      tok.k === 'or' ||
      tok.k === 'not' ||
      tok.k === 'rparen'
    ) {
      throw new Error('表达式语法错误');
    }
    throw new Error('表达式语法错误');
  }
  /**
   * 词法分析：把策略表达式源码切分为 token 序列。
   * @param src string
   * @returns Tok[]
   */
  public static tokenize(src: string): Tok[] {
    const toks: Tok[] = [];
    let i = 0;
    const n = src.length;
    while (i < n) {
      const c = src[i] ?? '';
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        i++;
        continue;
      }
      if (c === '(') {
        toks.push({ k: 'lparen' });
        i++;
        continue;
      }
      if (c === ')') {
        toks.push({ k: 'rparen' });
        i++;
        continue;
      }
      if (c === '"' || c === "'") {
        const quote = c;
        let j = i + 1;
        let s = '';
        while (j < n && src[j] !== quote) {
          s += src[j];
          j++;
        }
        if (j >= n) throw new Error('字符串未闭合');
        toks.push({ k: 'str', v: s });
        i = j + 1;
        continue;
      }
      if (c === '=' && src[i + 1] === '=') {
        toks.push({ k: 'op', v: '==' });
        i += 2;
        continue;
      }
      if (c === '!' && src[i + 1] === '=') {
        toks.push({ k: 'op', v: '!=' });
        i += 2;
        continue;
      }
      if (c === '~') {
        toks.push({ k: 'op', v: '~' });
        i++;
        continue;
      }
      if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
        let j = i + 1;
        while (j < n && /[0-9.]/.test(src[j] ?? '')) j++;
        const num = Number(src.slice(i, j));
        if (Number.isNaN(num)) throw new Error(`非法数字: ${src.slice(i, j)}`);
        toks.push({ k: 'num', v: num });
        i = j;
        continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        let j = i + 1;
        while (j < n && /[A-Za-z0-9_]/.test(src[j] ?? '')) j++;
        const word = src.slice(i, j);
        if (word === 'and') toks.push({ k: 'and' });
        else if (word === 'or') toks.push({ k: 'or' });
        else if (word === 'not') toks.push({ k: 'not' });
        else if (word === 'in') toks.push({ k: 'op', v: 'in' });
        else if (word === 'true') toks.push({ k: 'bool', v: true });
        else if (word === 'false') toks.push({ k: 'bool', v: false });
        else toks.push({ k: 'ident', v: word });
        i = j;
        continue;
      }
      throw new Error(`无法识别的字符: ${c}`);
    }
    return toks;
  }
}

/**
 * @beta
 * 编译一条表达式字符串为 AST（缓存由调用方决定；单次求值直接调 `test`）。
 * @param src 表达式源码。
 * @returns 解析出的 AST；语法错误时抛出（fail-closed 由调用方决定跳过策略）。
 */
export function compileExpression(src: string): Ast {
  return new Parser(Parser.tokenize(src)).parse();
}

/**
 * @beta
 * 零依赖安全策略求值器。
 */
export class SafePolicyEvaluator implements PolicyPort {
  /**
   * 对给定事实求值整个规则集：按序匹配，首条命中即生效；`when` 为空串视为恒真（兜底规则），
   * 解析失败的规则 fail-closed 跳过并记入 warnings；无命中返回默认决策（默认 'ask' 保守）。
   * @param rules 策略规则集（按声明顺序求值）。
   * @param facts 事实表；缺失标识符在比较中按空串、在真值判定中按 false 处理。
   * @param defaultEffect 无规则命中时的兜底效应，默认 'ask'。
   * @returns 最终决策（效应、命中规则名——无命中为 null、求值告警）。
   */
  public evaluate(
    rules: readonly PolicyRule[],
    facts: PolicyFacts,
    defaultEffect: PolicyEffect = 'ask',
  ): PolicyDecision {
    const warnings: string[] = [];
    for (const rule of rules) {
      let matched = false;
      try {
        matched =
          rule.when.trim() === ''
            ? true
            : SafePolicyEvaluator.evalAst(compileExpression(rule.when), facts);
      } catch (err) {
        // 规则表达式解析失败 → fail-closed：跳过该规则，绝不意外放行。
        warnings.push(`规则「${rule.name}」表达式解析失败已跳过: ${(err as Error).message}`);
        continue;
      }
      if (matched) {
        return { effect: rule.effect, matchedRule: rule.name, warnings };
      }
    }
    return { effect: defaultEffect, matchedRule: null, warnings };
  }

  /** 单独求值一条表达式（供工具/调试）：解析或求值失败一律返回 false（fail-closed，绝不意外放行）。
   * @param expression 策略表达式源码。
   * @param facts 事实表。
   * @returns 表达式真值；任何解析/求值异常都归一为 false。
   */
  public test(expression: string, facts: PolicyFacts): boolean {
    try {
      return SafePolicyEvaluator.evalAst(compileExpression(expression), facts);
    } catch {
      return false; // fail-closed
    }
  }
  /**
   * 递归求值 AST 为布尔结果（fail-closed：未知标识符按 false，非法正则/类型不匹配按 false）。
   * @param node Ast
   * @param facts PolicyFacts
   * @returns boolean
   */
  public static evalAst(node: Ast, facts: PolicyFacts): boolean {
    switch (node.t) {
      case 'val':
        return node.v === true;
      case 'ident': {
        const v = facts[node.name];
        return v === true;
      }
      case 'not':
        return !SafePolicyEvaluator.evalAst(node.e, facts);
      case 'and':
        return (
          SafePolicyEvaluator.evalAst(node.l, facts) && SafePolicyEvaluator.evalAst(node.r, facts)
        );
      case 'or':
        return (
          SafePolicyEvaluator.evalAst(node.l, facts) || SafePolicyEvaluator.evalAst(node.r, facts)
        );
      case 'cmp': {
        const left = SafePolicyEvaluator.resolve(node.l, facts);
        const right = SafePolicyEvaluator.resolve(node.r, facts);
        switch (node.op) {
          case '==':
            return SafePolicyEvaluator.looseEq(left, right);
          case '!=':
            return !SafePolicyEvaluator.looseEq(left, right);
          case '~': {
            if (typeof left !== 'string' || typeof right !== 'string') return false;
            try {
              return new RegExp(right).test(left);
            } catch {
              return false;
            }
          }
          case 'in': {
            if (Array.isArray(right)) return right.includes(left as string);
            if (typeof right === 'string') return right.includes(String(left));
            return false;
          }
        }
        return false;
      }
    }
  }
  /**
   * 解析操作数节点为比较用值：字面量原样、标识符查事实表（缺失按空串）、 子表达式保守求值为布尔（不支持嵌套集合语义）。
   * @param node Ast
   * @param facts PolicyFacts
   * @returns string | number | boolean | readonly string[]
   */
  public static resolve(
    node: Ast,
    facts: PolicyFacts,
  ): string | number | boolean | readonly string[] {
    if (node.t === 'val') return node.v;
    if (node.t === 'ident') {
      const v = facts[node.name];
      return v === undefined ? '' : v;
    }
    return SafePolicyEvaluator.evalAst(node, facts); // 子表达式（如 `in (a or b)` 不被支持，这里保守返回布尔）
  }
  /**
   * 宽松相等：数字/布尔按严格相等，其余一律转字符串比较（跨类型比较不抛错）。
   * @param a unknown
   * @param b unknown
   * @returns boolean
   */
  public static looseEq(a: unknown, b: unknown): boolean {
    if (typeof a === 'number' && typeof b === 'number') return a === b;
    if (typeof a === 'boolean' && typeof b === 'boolean') return a === b;
    return String(a) === String(b);
  }
}
