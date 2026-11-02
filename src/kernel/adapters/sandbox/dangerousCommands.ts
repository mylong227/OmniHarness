import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * 危险命令规则的单一真源加载器。
 *
 * 规则短语定义在仓库内唯一的 `dangerous-commands.json`（与 Rust 内核
 * `crates/omni-core/src/sandbox.rs` 经 `build.rs` 读取的是同一份文件）。本适配器在加载时读取该
 * JSON，得到一组「规范化后的子串短语」（大小写不敏感、空白已折叠、`|` 两侧空格已去）。匹配时先对命令做
 * 相同规范化，再做子串包含判定。
 *
 * ⚠️ 单一真源纪律：规则只改 `dangerous-commands.json`，绝不同时手写两份。双表腐化正是审计 §5 项 #18 的修复对象。
 */
export class DangerousCommands {
  /** 默认危险模式（规范化子串短语）。 */
  private readonly patterns: readonly string[];

  /**
   * 构造时从单一真源 JSON 载入规则短语。
   */
  public constructor() {
    this.patterns = DangerousCommands.loadPatterns();
  }

  /**
   * 默认危险模式列表（规范化子串短语，大小写不敏感）。
   * @returns 覆盖 Windows/Unix 常见破坏性命令的子串短语数组。
   */
  public defaults(): readonly string[] {
    return this.patterns;
  }

  /**
   * 规范化命令：小写 + 折叠空白 + 去除管道两侧空格（与 Rust `normalize` 完全一致）。
   * @param command 原始命令串（非字符串按空串处理，避免上游传入 undefined/null 时抛异常）。
   * @returns 规范化后的命令串。
   */
  public normalize(command: unknown): string {
    if (typeof command !== 'string') {
      return '';
    }
    const lowered = command.toLowerCase();
    const collapsed = lowered.split(/\s+/).join(' ');
    return collapsed.replace(/ \| /g, '|');
  }

  /**
   * 判定命令是否命中危险规则；命中返回匹配到的短语，否则 null。
   * @param command 待检查命令。
   * @param extraPatterns 额外危险子串短语（用户/适配器补充，可选）。
   * @returns 命中的短语；未命中为 null。
   */
  public match(command: string, extraPatterns: readonly string[] = []): string | null {
    const normalized = this.normalize(command);
    for (const pattern of [...this.patterns, ...extraPatterns]) {
      if (normalized.includes(pattern)) {
        return pattern;
      }
    }
    return null;
  }

  /**
   * 从单一真源 JSON 读取规则短语。
   * @returns 规则短语数组。
   */
  private static loadPatterns(): readonly string[] {
    const here = dirname(fileURLToPath(import.meta.url));
    const jsonPath = join(here, 'dangerous-commands.json');
    const raw = readFileSync(jsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { patterns: readonly string[] };
    return parsed.patterns;
  }
}

/** 默认实例（无状态、可并发复用，调用点以 `dangerousCommands.xxx` 零构造复用）。 */
export const dangerousCommands = new DangerousCommands();
