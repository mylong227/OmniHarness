import { AuditFormatting } from './auditFormatting.ts';
import { AuditRedactionValues } from './auditRedactionValues.ts';
import type {
  AuditLoadedSource,
  AuditRecordDraft,
  AuditRedactMode,
  AuditRedactionInfo,
} from './auditTypes.ts';

/**
 * 审计报告的**脱敏器**（2026-11-04 P3 T3.1）——把"能看"的报告变成"敢发"的报告。
 *
 * ## 三类规则（PLAN_2026-11.md T3.1）
 *
 * 1. `absolute-paths`：绝对路径（盘符 / UNC / 常见 home 根）→ **保留末两段 + 8 位哈希**——
 *    审阅者仍知道动的是哪个文件，但看不到机器的目录结构；
 * 2. `secret-prefix`：已知密钥前缀（sk-ant- / sk-proj- / ghp_ / github_pat_ / xox…- /
 *    AKIA / `Bearer <token>`）→ 整体替换；
 * 3. `secret-assignment`：`*KEY/TOKEN/SECRET/PASSWORD* = 值` 赋值形态 → **变量名保留**、
 *    值替换（审阅者知道"这里有个 key"，不知道值）；
 *    另有 `high-entropy`（熵阈值）兜底：长度 ≥ 24 且按字符频率的香农熵 > 4.3 的长随机串——
 *    16 符号字母表（十六进制哈希）数学上限 4.0，**到不了这条线**，因此 git SHA / 摘要不会被误伤，
 *    base64url 类高熵令牌在线以上。
 *
 * ## 稳定标记（同值同标）
 *
 * 标记是**原值的纯函数**：`[REDACTED:<rule>:<显示段>#<SHA-256 前 8 位>]`。同一个原值在
 * 整份报告里得到同一个标记，跨记录可交叉比对；标记内含原值哈希前 8 位——可验证"两处
 * 是不是同一个值"，但**不可还原原值**（这个边界写在 docs/audit/README.md §4）。
 *
 * ## 口径
 *
 * - 模式默认 **off**（证据保真优先）；`paths` 只走路径规则；`secrets` 只走密钥三条；
 *   `all` 全部。命中数（`hits`）= 脱敏载体（records + source.path/workspace）里的标记数
 *   （输入自带的字面标记也计入——脱敏不改写它们，用占位保护避免二次替换），
 *   `audit verify` 机械重算对账（改 `redaction.hits` ⇒ 判 `redaction` 红，与 summary /
 *   coverage 同一套机械防线）；`redaction` 摘要本身由 `AuditChain.seal` 绑定链头——
 *   删字段 / 改 mode ⇒ `head` 红；
 * - `source.sha256` **不参与脱敏**——它把报告与原始输入文件绑定，脱敏只是展示层的变换；
 * - 不处理图片 / 二进制内嵌文本；这是尽力而为的遮蔽，**不是 DLP**（边界同上）。
 */
export class AuditRedactor {
  /** 规则名：绝对路径。 */
  public static readonly RULE_PATHS = 'absolute-paths';
  /** 规则名：已知密钥前缀。 */
  public static readonly RULE_PREFIX = 'secret-prefix';
  /** 规则名：KEY/TOKEN/SECRET 赋值。 */
  public static readonly RULE_ASSIGN = 'secret-assignment';
  /** 规则名：高熵令牌兜底。 */
  public static readonly RULE_ENTROPY = 'high-entropy';

  /** 熵规则的长度下限（短串误伤面太大）。 */
  public static readonly MIN_ENTROPY_TOKEN_CHARS = 24;

  /** 熵阈值：16 符号字母表（hex）的数学上限是 4.0，4.3 之上只有 ≥64 符号字母表的串。 */
  public static readonly ENTROPY_THRESHOLD = 4.3;

  /**
   * 脱敏标记的识别式（`verify` 重算 hits 用；`g` 标志配合 `String.match` 使用，
   * `match` 会一次性返回全部命中，无 lastIndex 状态问题）。
   */
  public static readonly MARKER_PATTERN = /\[REDACTED:(?:paths|secrets):[^\]]*\]/g;

  /**
   * 占位槽（规则执行期间把已有标记暂时换出）。NUL + 序号 + NUL 不匹配任何规则，
   * 因此后续规则不会把标记内部（如长路径显示段）当成新的敏感串二次改写。
   */
  private static readonly MARKER_SLOT_RE = /\u0000(\d+)\u0000/g;

  /** Windows 盘符 / UNC 绝对路径（到空白或引号为止）。 */
  private static readonly WIN_PATH_RE = /(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>|]{2,}/g;

  /** 常见 home 根的 Unix 绝对路径（`/usr/lib` 这类系统路径不遮——遮了反而没法读）。 */
  private static readonly UNIX_PATH_RE =
    /\/(?:home|Users|root|mnt|media|srv|opt|data)\/[^\s"'`<>]{2,}/g;

  /** 已知密钥前缀。 */
  private static readonly SECRET_PREFIX_RE =
    /(sk-ant-[A-Za-z0-9_\-]{10,}|sk-proj-[A-Za-z0-9_\-]{10,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9\-]{10,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._\-]{20,})/g;

  /** `*KEY/TOKEN/SECRET/PASSWORD* = 值` 赋值（变量名保留、值替换；值不可再是已脱敏标记）。 */
  private static readonly SECRET_ASSIGN_RE =
    /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*)(\s*[=:]\s*)([^,\s"'\[]{1,200})/gi;

  /** 高熵长串兜底（含 base64url / JWT 片段字符）。 */
  private static readonly ENTROPY_TOKEN_RE = /[A-Za-z0-9+/_=-]{24,}/g;

  /**
   * 对一个已加载来源做脱敏（**纯函数**：不改动入参，产出新来源与摘要）。
   * @param loaded 已加载并解析的来源。
   * @param mode 脱敏模式（off 时原样返回、hits 0）。
   * @returns 脱敏后的来源（`sha256` 保持原值——绑定的是原始输入文件）与脱敏摘要。
   */
  public static redactSource(
    loaded: AuditLoadedSource,
    mode: AuditRedactMode,
  ): { readonly source: AuditLoadedSource; readonly info: AuditRedactionInfo } {
    const rules = AuditRedactor.rulesFor(mode);
    // `hits` 的定义是「脱敏载体里的标记数」：输入正文里本来就有的字面标记也计入
    // （脱敏不改写它们，下列规则也会先用占位符保护）。off 模式不处理、恒为 0。
    let hits =
      rules.length === 0
        ? 0
        : AuditRedactor.countMarkers({
            records: loaded.result.records,
            path: loaded.path,
            workspace: loaded.result.workspace,
          });
    const records = loaded.result.records.map((draft) => {
      const outcome = AuditRedactor.redactDraft(draft, rules);
      hits += outcome.hits;
      return outcome.draft;
    });
    const pathOutcome = AuditRedactor.redactText(loaded.path, rules);
    const workspaceOutcome = AuditRedactor.redactText(loaded.result.workspace ?? '', rules);
    hits += pathOutcome.hits + workspaceOutcome.hits;
    const source: AuditLoadedSource = {
      ...loaded,
      path: pathOutcome.text,
      result: {
        ...loaded.result,
        records,
        ...(loaded.result.workspace === null ? {} : { workspace: workspaceOutcome.text }),
      },
    };
    return { source, info: { mode, rules, hits } };
  }

  /**
   * 按脱敏载体（records + path/workspace）里的标记数重算命中数（`verify` 对账用；
   * 与 `info.hits` 必须相等）。
   * @param records 脱敏载体（任意可 JSON 化的记录集合）。
   * @returns 标记出现次数。
   */
  public static countMarkers(records: unknown): number {
    const text = JSON.stringify(records);
    return text.match(AuditRedactor.MARKER_PATTERN)?.length ?? 0;
  }

  /**
   * 脱敏摘要的人类可读标签（报告卡片 / 摘要表 / CLI 摘要行共用）。
   * @param info 脱敏摘要。
   * @returns 形如 `all · 5 处` / `off` 的标签。
   */
  public static modeLabel(info: AuditRedactionInfo): string {
    return info.hits > 0 ? `${info.mode} · ${AuditFormatting.number(info.hits)} 处` : info.mode;
  }

  /**
   * 模式 → 规则清单。
   * @param mode 模式。
   * @returns 依次应用的规则 id（off 为空表）。
   */
  private static rulesFor(mode: AuditRedactMode): readonly string[] {
    switch (mode) {
      case 'paths':
        return [AuditRedactor.RULE_PATHS];
      case 'secrets':
        return [AuditRedactor.RULE_ASSIGN, AuditRedactor.RULE_PREFIX, AuditRedactor.RULE_ENTROPY];
      case 'all':
        return [
          AuditRedactor.RULE_PATHS,
          AuditRedactor.RULE_ASSIGN,
          AuditRedactor.RULE_PREFIX,
          AuditRedactor.RULE_ENTROPY,
        ];
      default:
        return [];
    }
  }

  /**
   * 脱敏一条草稿记录（text / title / files / fileStats 路径；meta 与 callId 不动）。
   * @param draft 草稿记录。
   * @param rules 规则清单。
   * @returns 新草稿（未命中时原样）与命中数。
   */
  private static redactDraft(
    draft: AuditRecordDraft,
    rules: readonly string[],
  ): { readonly draft: AuditRecordDraft; readonly hits: number } {
    const textOutcome = AuditRedactor.redactText(draft.text, rules);
    const titleOutcome = AuditRedactor.redactText(draft.title, rules);
    let hits = textOutcome.hits + titleOutcome.hits;
    const files =
      draft.files === undefined
        ? undefined
        : draft.files.map((file) => {
            const outcome = AuditRedactor.redactText(file, rules);
            hits += outcome.hits;
            return outcome.text;
          });
    const fileStats =
      draft.fileStats === undefined
        ? undefined
        : draft.fileStats.map((stat) => {
            const outcome = AuditRedactor.redactText(stat.path, rules);
            hits += outcome.hits;
            return { ...stat, path: outcome.text };
          });
    const changed =
      hits > 0 || textOutcome.text !== draft.text || titleOutcome.text !== draft.title;
    if (!changed) {
      return { draft, hits: 0 };
    }
    return {
      draft: {
        ...draft,
        text: textOutcome.text,
        title: titleOutcome.text,
        ...(files === undefined ? {} : { files }),
        ...(fileStats === undefined ? {} : { fileStats }),
      },
      hits,
    };
  }

  /**
   * 对一段文本依次应用规则清单。
   * @param text 原文本。
   * @param rules 规则清单。
   * @returns 新文本与命中数。
   */
  private static redactText(
    text: string,
    rules: readonly string[],
  ): { readonly text: string; readonly hits: number } {
    let current = text;
    let hits = 0;
    for (const rule of rules) {
      // 已有标记先占位保护：否则后置规则（如高熵兜底）可能把标记里的长显示段
      // 当成新令牌二次替换，产出嵌套标记——hits 会多算，verify 的标记数对账必红。
      const held: string[] = [];
      const masked = current.replace(AuditRedactor.MARKER_PATTERN, (marker) => {
        held.push(marker);
        return `\u0000${String(held.length - 1)}\u0000`;
      });
      const outcome = AuditRedactor.applyRule(masked, rule);
      current = outcome.text.replace(
        AuditRedactor.MARKER_SLOT_RE,
        (slot, index: string) => held[Number(index)] ?? slot,
      );
      hits += outcome.hits;
    }
    return { text: current, hits };
  }

  /**
   * 应用单条规则。
   * @param text 文本。
   * @param rule 规则 id。
   * @returns 新文本与命中数。
   */
  private static applyRule(
    text: string,
    rule: string,
  ): { readonly text: string; readonly hits: number } {
    switch (rule) {
      case AuditRedactor.RULE_PATHS:
        return AuditRedactor.replaceMatches(
          text,
          'paths',
          AuditRedactor.WIN_PATH_RE,
          AuditRedactor.UNIX_PATH_RE,
        );
      case AuditRedactor.RULE_ASSIGN:
        return AuditRedactor.replaceAssignments(text);
      case AuditRedactor.RULE_PREFIX:
        return AuditRedactor.replaceMatches(text, 'secrets', AuditRedactor.SECRET_PREFIX_RE);
      case AuditRedactor.RULE_ENTROPY:
        return AuditRedactor.replaceHighEntropy(text);
      default:
        return { text, hits: 0 };
    }
  }

  /**
   * 把一个或多个全局正则的命中替换为稳定标记（每个命中独立计一次）。
   * @param text 文本。
   * @param category 标记类别（`paths` / `secrets`——重算正则只认这两个值）。
   * @param patterns 全局正则。
   * @returns 新文本与命中数。
   */
  private static replaceMatches(
    text: string,
    category: 'paths' | 'secrets',
    ...patterns: readonly RegExp[]
  ): { readonly text: string; readonly hits: number } {
    let current = text;
    let hits = 0;
    for (const pattern of patterns) {
      current = current.replace(pattern, (matched) => {
        hits += 1;
        return AuditRedactor.marker(category, matched);
      });
    }
    return { text: current, hits };
  }

  /**
   * 赋值形态：变量名与分隔符保留，值换成稳定标记（值已是标记则不动——幂等）。
   * @param text 文本。
   * @returns 新文本与命中数。
   */
  private static replaceAssignments(text: string): {
    readonly text: string;
    readonly hits: number;
  } {
    let hits = 0;
    const next = text.replace(AuditRedactor.SECRET_ASSIGN_RE, (matched, name, sep, value) => {
      if (value.startsWith('[REDACTED:')) {
        return matched;
      }
      hits += 1;
      return `${name}${sep}${AuditRedactor.marker('secrets', value)}`;
    });
    return { text: next, hits };
  }

  /**
   * 高熵兜底：长度与熵都过线的长随机串整体替换。
   * @param text 文本。
   * @returns 新文本与命中数。
   */
  private static replaceHighEntropy(text: string): {
    readonly text: string;
    readonly hits: number;
  } {
    let hits = 0;
    const next = text.replace(AuditRedactor.ENTROPY_TOKEN_RE, (token) => {
      if (
        token.length < AuditRedactor.MIN_ENTROPY_TOKEN_CHARS ||
        AuditRedactionValues.entropyOf(token) <= AuditRedactor.ENTROPY_THRESHOLD
      ) {
        return token;
      }
      hits += 1;
      return AuditRedactor.marker('secrets', token);
    });
    return { text: next, hits };
  }

  /**
   * 构造稳定标记（原值的纯函数——同值同标）。类别只有 `paths` / `secrets` 两种：
   * paths 显示末两段（审阅者知道动的是哪个文件），secrets 不带显示段。
   *
   * 同一个语义值在不同载体里的**书写形态不同**（原生反斜杠 / JSON 转义双反斜杠 /
   * 审计规范化正斜杠 / 大小写变体），哈希必须基于**规范化形态**——否则同一路径
   * 会产出不同标记、跨记录对不上（2026-11-04 判据实测抓到：一条路径三种标记）：
   * - `paths`：`\` → `/`、折叠连续斜杠、小写（Windows 路径大小写不敏感），显示段同源；
   * - `secrets`：剥离 `Bearer ` 前缀后原样哈希（令牌大小写敏感，不做其它改写）。
   * @param category 类别。
   * @param original 原值（匹配到的原始书写形态）。
   * @returns 标记文本。
   */
  private static marker(category: 'paths' | 'secrets', original: string): string {
    const canonical =
      category === 'paths'
        ? AuditRedactionValues.normalizePath(original)
        : original.replace(/^Bearer\s+/i, '');
    const display = category === 'paths' ? AuditRedactionValues.lastTwoSegments(canonical) : '';
    return `[REDACTED:${category}:${display}#${AuditRedactionValues.hash8(canonical)}]`;
  }
}
