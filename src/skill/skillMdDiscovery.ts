import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillEntry } from '../ports/skill/skillEntry.ts';
import { SkillMdCodec } from './skillMdCodec.ts';
import { log } from '../util/logger.ts';

/**
 * `SKILL.md` 工作区发现（INT-04，2026-10-21）。
 *
 * 此前技能只能经配置文件内联或 CLI `--skills <file>` 进入，工作区里放好的
 * `.omniharness/skills/<name>/SKILL.md`（以及 Claude Code 兼容的 `.claude/skills`）
 * 永远不会被读到——「SKILL.md 可移植」只完成了导入通道，没完成自动发现。
 *
 * 2026-10-22 起支持 `.agents/skills`（跨工具 Agent Skills 约定），但**默认关闭**：
 * 工作区技能会注入系统提示，`.agents` 是新增攻击面；需显式 `OMNI_AGENTS_SKILLS=1` 才扫描。
 * 扫描优先级 `.omniharness` > `.claude` > `.agents`，同名只保留先扫到的。
 *
 * 口径：
 *  - 只扫**直接子目录**，每个子目录读 `SKILL.md`；文件不存在/解析失败**跳过并告警**，不阻断启动；
 *  - 显式配置/CLI 的同名技能优先（由调用方合并时去重）；
 *  - 目录不存在是正常情况（零 IO 成本、零行为变更）。
 */
export class SkillMdDiscovery {
  /** 扫描目录（相对工作区根；按顺序扫描，后面的同名技能不覆盖前面的）。 */
  private static readonly DIRS = [join('.omniharness', 'skills'), join('.claude', 'skills')];

  /** 跨工具约定目录（opt-in，避免默认扩大工作区提示注入面）。 */
  private static readonly AGENTS_DIR = join('.agents', 'skills');

  /**
   * 发现工作区内的 SKILL.md 技能。
   * @param workspaceRoot 工作区根目录。
   * @returns 解析出的技能条目（可能为空；同名只保留首次出现）。
   */
  public static discover(workspaceRoot: string): SkillEntry[] {
    const dirs = [...SkillMdDiscovery.DIRS];
    if (process.env.OMNI_AGENTS_SKILLS === '1') {
      dirs.push(SkillMdDiscovery.AGENTS_DIR);
    }
    const found = new Map<string, SkillEntry>();
    for (const relative of dirs) {
      for (const entry of SkillMdDiscovery.scan(join(workspaceRoot, relative))) {
        if (!found.has(entry.name)) found.set(entry.name, entry);
      }
    }
    return [...found.values()];
  }

  /**
   * 扫描一个技能根目录下的直接子目录。
   * @param root 技能根目录（不存在时返回空）。
   * @returns 解析出的技能条目。
   */
  private static scan(root: string): SkillEntry[] {
    let names: string[];
    try {
      names = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      // 目录不存在/不可读：正常情况，不当作错误。
      return [];
    }
    const out: SkillEntry[] = [];
    for (const name of names) {
      const file = join(root, name, 'SKILL.md');
      try {
        if (!existsSync(file) || !statSync(file).isFile()) continue;
        out.push(SkillMdCodec.parse(readFileSync(file, 'utf8'), name));
      } catch (error) {
        log.warn('skill.discovery.parse_failed', {
          file,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return out;
  }
}
