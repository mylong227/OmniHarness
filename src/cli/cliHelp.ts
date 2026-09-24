import { builtinDefaults } from '../util/builtinDefaults.js';
import {
  A2A_TRANSPORTS,
  APPROVAL_ASKS,
  APPROVALS,
  BUDGET_ON_EXCEED,
  ELEVATED_SANDBOXES,
  ENFORCEMENT_MODES,
  ESCALATIONS,
  EVENT_PORTS,
  KV_ADAPTERS,
  MODEL_ADAPTERS,
  OUTPUT_FORMATS,
  SANDBOX_PROFILES,
  SPILL_ADAPTERS,
  STORAGE_ADAPTERS,
} from './cliEnums.js';

/**
 * 帮助文本里可引用的枚举源（占位符名 → 取值清单）。
 *
 * 值**全部来自 `cliEnums`**（解析期校验用的同一批常量）⇒ 帮助里展示的枚举不可能与行为不一致。
 * 此前帮助把 `--storage-adapter memory|jsonl` 手写在代码里，而白名单早已是 `memory|jsonl|sqlite`。
 */
export const HELP_ENUM_SOURCES: Readonly<Record<string, readonly string[]>> = {
  modelAdapters: MODEL_ADAPTERS,
  storageAdapters: STORAGE_ADAPTERS,
  approvals: APPROVALS,
  approvalAsks: APPROVAL_ASKS,
  sandboxProfiles: SANDBOX_PROFILES,
  escalations: ESCALATIONS,
  elevatedSandboxes: ELEVATED_SANDBOXES,
  eventPorts: EVENT_PORTS,
  spillAdapters: SPILL_ADAPTERS,
  outputFormats: OUTPUT_FORMATS,
  kvAdapters: KV_ADAPTERS,
  a2aTransports: A2A_TRANSPORTS,
  budgetOnExceed: BUDGET_ON_EXCEED,
  enforcementModes: ENFORCEMENT_MODES,
};

/** 描述列的起始列（命令段与选项段共用；不足补空白，超出留 `MIN_GAP` 个空格）。 */
const DESCRIPTION_COLUMN = 36;

/** spec 过长时的最小间隔（不至于与描述黏在一起）。 */
const MIN_GAP = 3;

/** 命令段缩进。 */
const COMMAND_INDENT = 6;

/** 选项段缩进。 */
const OPTION_INDENT = 2;

/** 帮助里的一条条目（命令或选项）。 */
interface HelpEntry {
  /** 左侧用法片段（命令用法或旗标 + 取值）。 */
  readonly spec: string;
  /** 右侧说明。 */
  readonly description: string;
}

/**
 * CLI 帮助渲染器（`omniharness --help`）。
 *
 * ## 为什么要有这个类（用户指令：帮助文本也不该硬写在代码里）
 *
 * 原先整份帮助是一段 **80 余行的字符串数组**写死在 `argParser.printUsage()` 里，于是 CLI 表面
 * 有了**第三份副本**：旗标名、枚举取值、默认值在 `cliFlagTable`（解析）/ `cliEnums`（校验）/
 * `CliDefaults`（默认值）里各有一份，帮助里再抄一遍——实测**已经漂移**：
 * 帮助写 `--storage-adapter memory|jsonl`，而白名单是 `memory|jsonl|sqlite`（用户按帮助选不到 sqlite）。
 *
 * 现帮助的**文案**移入数据文件 `defaults/cliHelp.json`（改文案不改代码），**枚举取值**在渲染时
 * 从 `HELP_ENUM_SOURCES`（即 `cliEnums`）派生。数据文件里用 `{{枚举源名}}` 占位；
 * 占位符无法解析即**抛错**（fail-closed，不静默留一段 `{{...}}` 给用户看）。
 *
 * ## 排版口径（与历史逐字一致）
 *
 * 两段共用描述列 `36`：spec 补空白对齐到该列；spec 过长（补不出间隔）则追加 3 个空格。
 */
export class CliHelp {
  /** 标题行。 */
  private readonly title: string;
  /** 用法行（`用法: omniharness exec …`）。 */
  private readonly usageLine: string;
  /** 子命令清单。 */
  private readonly commands: readonly HelpEntry[];
  /** 选项段小标题（`选项:`）。 */
  private readonly optionsTitle: string;
  /** 选项清单（含命令式条目，如 `eval …` / `daemon start|stop|status`）。 */
  private readonly options: readonly HelpEntry[];
  /** 构造期解析占位符时记录到的枚举源名（`enumSources()` 据此作答）。 */
  private readonly referenced = new Set<string>();

  /**
   * @param raw `defaults/cliHelp.json` 的原始内容（构造期校验结构并解析全部枚举占位符）。
   * @throws Error 结构非法、条目缺字段或占位符无法解析时抛出
   */
  public constructor(raw: unknown) {
    const root = this.asRecord(raw, 'defaults/cliHelp.json');
    this.title = this.requireText(root['title'], 'title');
    this.usageLine = this.requireText(root['usageLine'], 'usageLine');
    this.optionsTitle = this.requireText(root['optionsTitle'], 'optionsTitle');
    this.commands = this.parseEntries(root['commands'], 'commands');
    this.options = this.parseEntries(root['options'], 'options');
  }

  /**
   * 渲染整份帮助（含**结尾换行**，可直接写 stdout）。
   * @returns 帮助文本。
   */
  public render(): string {
    const lines = [this.title, this.usageLine];
    for (const entry of this.commands) {
      lines.push(this.lineOf(COMMAND_INDENT, entry));
    }
    lines.push(this.optionsTitle);
    for (const entry of this.options) {
      lines.push(this.lineOf(OPTION_INDENT, entry));
    }
    return `${lines.join('\n')}\n`;
  }

  /**
   * 帮助里引用过的枚举源名（去重，按首次出现顺序）。
   *
   * 占位符在**构造期**即被替换（fail-closed），故此处返回构造时记录下来的引用，
   * 而不是从已解析文本里回捞（那时已经没有 `{{...}}` 了）。
   * @returns 枚举源名列表。
   */
  public enumSources(): readonly string[] {
    return [...this.referenced];
  }

  /**
   * 帮助里**声明过的**全部旗标名（命令段 + 选项段都算：命令用法里写了缩写旗标也算文档化了）。
   * 长旗标（`--x`）与单字母短旗标（`-p`）都计入。
   * @returns 旗标名列表（去重）。
   */
  public documentedFlags(): readonly string[] {
    const found = new Set<string>();
    for (const entry of [...this.commands, ...this.options]) {
      for (const m of entry.spec.matchAll(
        /(?<![\w-])--[a-z][a-z0-9-]*|(?<![\w-])-[a-zA-Z](?![\w-])/g,
      )) {
        found.add(m[0]);
      }
    }
    return [...found];
  }

  /**
   * 渲染一行：`indent + spec` 对齐到描述列，再接描述。
   * @param indent 缩进空格数。
   * @param entry 条目。
   * @returns 一行文本。
   */
  private lineOf(indent: number, entry: HelpEntry): string {
    const padTo = DESCRIPTION_COLUMN - indent;
    const left =
      entry.spec.length + MIN_GAP <= padTo
        ? entry.spec.padEnd(padTo)
        : `${entry.spec}${' '.repeat(MIN_GAP)}`;
    return `${' '.repeat(indent)}${left}${entry.description}`;
  }

  /**
   * 解析一段条目（命令或选项）。
   * @param raw 原始值。
   * @param where 报错定位。
   * @returns 条目列表（占位符已解析）。
   * @throws Error 非数组、条目非法或占位符无法解析时抛出
   */
  private parseEntries(raw: unknown, where: string): readonly HelpEntry[] {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error(`defaults/cliHelp.json 的 ${where} 应为非空数组`);
    }
    return raw.map((item, index) => {
      const at = `${where}[${index}]`;
      const record = this.asRecord(item, at);
      const specKey = where === 'commands' ? 'usage' : 'spec';
      return {
        spec: this.resolve(this.requireText(record[specKey], `${at}.${specKey}`), at),
        description: this.requireText(record['description'], `${at}.description`),
      };
    });
  }

  /**
   * 解析 `{{枚举源名}}` 占位符。
   * @param text 原始文本。
   * @param where 报错定位。
   * @returns 已替换文本。
   * @throws Error 引用了未登记的枚举源时抛出（fail-closed，绝不把 `{{x}}` 渲染给用户）
   */
  private resolve(text: string, where: string): string {
    return text.replace(/\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g, (_full, name: string) => {
      const values = HELP_ENUM_SOURCES[name];
      if (values === undefined) {
        throw new Error(
          `${where} 引用了未登记的枚举源 "{{${name}}}"（可用：${Object.keys(HELP_ENUM_SOURCES).join(' / ')}）`,
        );
      }
      this.referenced.add(name);
      return values.join('|');
    });
  }

  /**
   * 断言为普通对象。
   * @param value 待判值。
   * @param where 报错定位。
   * @returns 收窄为 Record。
   * @throws Error 非普通对象时抛出。
   */
  private asRecord(value: unknown, where: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${where} 应为对象`);
    }
    return value as Record<string, unknown>;
  }

  /**
   * 非空字符串校验。
   * @param value 待校验值。
   * @param where 报错定位。
   * @returns 原字符串。
   * @throws Error 非字符串或全空白时抛出。
   */
  private requireText(value: unknown, where: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${where} 应为非空字符串（当前 ${JSON.stringify(value)}）`);
    }
    return value;
  }
}

/** 默认实例：数据在构造期读出并校验，缺文件 / 结构非法 / 坏占位符即当场抛错。 */
export const cliHelp = new CliHelp(builtinDefaults.json('cliHelp'));
