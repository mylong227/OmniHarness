/**
 * `--skills` 旗标的技能包加载与合并（CLI 输入通道）。
 *
 * ## 为什么单独一个类
 *
 * 技能包有两个来源：配置文件内联数组（`skills`）与 `--skills <file.json>` 旗标（可重复）。
 * 两者必须在**同一处**合并并走同一份校验——否则会出现「配置文件能写、旗标报错」或
 * 「同名技能在两条路径上表现不同」这类分叉判定，而分叉点离使用者很远、极难排查。
 *
 * ## 合并语义（刻意的选择）
 *
 * `SkillRegistry.register` 对重名**直接抛错**（这是对的：技能会注入系统提示，静默覆盖更危险）。
 * 但那意味着「文件里定义过、旗标里又定义一次」会在装配期炸出一个与配置无关的报错。故本类
 * 在合并时就按名字去重：**旗标优先**（命令行是更明确的意图表达），并在文件内部/多份旗标之间
 * 保留「后出现者覆盖前者」的一致性——合并后交给装配层的技能表必然无重名。
 *
 * 零第三方依赖；只做「读文件 + 校验 + 合并」，不碰注册表（装配仍是 `ConfigFactory` 的事）。
 */
import { readFileSync } from 'node:fs';

import type { SkillEntry } from '../skill/skill.js';
import { normalizeSkillEntries } from '../config/configError.js';
import type { CliArgs } from './argParser.js';

/** `--skills` 技能包解析器（纯静态工具类）。 */
export class CliSkillFlags {
  private constructor() {}

  /**
   * 合并「配置文件内联技能」与 `--skills` 旗标指向的技能包。
   *
   * 顺序：配置内联 → 各 `--skills` 文件（按命令行出现顺序）→ 同名后者覆盖前者。
   *
   * @param args 已解析的 CLI 参数（读 `skills` 与 `skillsFile`）。
   * @param readFile 文件读取函数（默认 `node:fs` 的 `readFileSync`；测试注入用）。
   * @returns 去重后的技能清单；两个来源都没有时为空数组（装配层据此不写 `skills` 键，零行为变更）。
   * @throws ConfigError 文件不可读/JSON 非法/技能结构不合法（fail-closed，附来源路径）
   */
  public static resolve(
    args: Pick<CliArgs, 'skills' | 'skillsFile'>,
    readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
  ): readonly SkillEntry[] {
    const merged = new Map<string, SkillEntry>();
    for (const skill of args.skills ?? []) {
      merged.set(skill.name, skill);
    }
    for (const path of args.skillsFile ?? []) {
      for (const skill of CliSkillFlags.loadFile(path, readFile)) {
        merged.set(skill.name, skill);
      }
    }
    return [...merged.values()];
  }

  /**
   * 读取并校验一份技能包文件。
   *
   * @param path JSON 文件路径（数组，或 `{ "skills": [...] }`）。
   * @param readFile 文件读取函数（注入用）。
   * @returns 该文件声明的技能清单。
   * @throws Error 读取失败或 JSON 非法时抛出**带路径与原因**的错误（不吞成「配置错误」以外的形态）
   */
  private static loadFile(path: string, readFile: (path: string) => string): readonly SkillEntry[] {
    const source = `--skills ${path}`;
    let text: string;
    try {
      text = readFile(path);
    } catch (error) {
      throw new Error(
        `${source}: 无法读取技能包文件（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `${source}: JSON 解析失败（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
    return normalizeSkillEntries(parsed, source);
  }
}
