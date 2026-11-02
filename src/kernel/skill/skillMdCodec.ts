import { createRequire } from 'node:module';
import type { SkillEntry } from './skill.ts';

/** 可选 YAML 解析器的最小结构（避免把可选依赖的类型带进构建硬依赖）。 */
type YamlParse = (input: string) => unknown;

/**
 * `SKILL.md` 编解码（INT-04，2026-10-20）。
 *
 * 形态：YAML frontmatter（name/description/tags）+ Markdown 正文（instructions）。
 * 优先用可选 `yaml` 解析完整 YAML；缺失时回退单行解析。两条路径都校验
 * name/description/正文，缺字段 fail-closed。
 */
export class SkillMdCodec {
  /**
   * 解析 `SKILL.md` 文本。
   * @param text 文件内容。
   * @param fallbackName 缺省技能名（通常取文件名/目录名）。
   * @returns 技能条目。
   * @throws Error frontmatter 缺失/字段非法时抛出（fail-closed）。
   */
  public static parse(
    text: string,
    fallbackName?: string,
    trust: 'bundled' | 'workspace' = 'workspace',
  ): SkillEntry {
    const normalized = text.replace(/^\uFEFF/, '');
    const viaMatter = SkillMdCodec.fromMatter(normalized, fallbackName, trust);
    if (viaMatter !== undefined) return viaMatter;
    if (!normalized.startsWith('---')) {
      throw new Error('SKILL.md 缺少 frontmatter（首行必须是 ---）');
    }
    const end = normalized.indexOf('\n---', 3);
    if (end < 0) {
      throw new Error('SKILL.md frontmatter 未闭合（缺少结束的 ---）');
    }
    const header = normalized.slice(3, end).trim();
    const body = normalized
      .slice(end + 4)
      .replace(/^\r?\n/, '')
      .trim();
    const fields = new Map<string, string>();
    for (const line of header.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const at = trimmed.indexOf(':');
      if (at <= 0) {
        throw new Error(`SKILL.md frontmatter 无法解析：${trimmed}`);
      }
      fields.set(trimmed.slice(0, at).trim(), trimmed.slice(at + 1).trim());
    }
    const name = (fields.get('name') ?? fallbackName ?? '').trim();
    const description = (fields.get('description') ?? '').trim();
    if (name === '' || description === '' || body === '') {
      throw new Error('SKILL.md 需要非空 name/description 与正文 instructions');
    }
    const tags = SkillMdCodec.tagsOf(fields.get('tags'));
    const resources = SkillMdCodec.tagsOf(fields.get('resources'));
    const exclusive = fields.get('exclusive') === 'true';
    return {
      name,
      description,
      instructions: body,
      trust,
      ...(tags.length > 0 ? { tags } : {}),
      ...(resources.length > 0 ? { resources } : {}),
      ...(exclusive ? { exclusive } : {}),
    };
  }

  /**
   * 用可选 `yaml` 解析 YAML frontmatter；缺失/失败/字段不全时返回 undefined。
   * @param text 规范化文本。
   * @param fallbackName 缺省技能名。
   * @returns 技能条目或 undefined。
   */
  private static fromMatter(
    text: string,
    fallbackName: string | undefined,
    trust: 'bundled' | 'workspace',
  ): SkillEntry | undefined {
    const parse = SkillMdCodec.yamlParser();
    if (parse === undefined || !text.startsWith('---')) return undefined;
    const end = text.indexOf('\n---', 3);
    if (end < 0) return undefined;
    const header = text.slice(3, end).trim();
    const instructions = text
      .slice(end + 4)
      .replace(/^\r?\n/, '')
      .trim();
    if (header === '') return undefined;
    try {
      const data = parse(header);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
      const record = data as Record<string, unknown>;
      const name =
        typeof record['name'] === 'string' ? record['name'].trim() : (fallbackName ?? '');
      const description =
        typeof record['description'] === 'string' ? record['description'].trim() : '';
      if (name === '' || description === '' || instructions === '') return undefined;
      const tags = SkillMdCodec.tagsOfValue(record['tags']);
      const resources = SkillMdCodec.tagsOfValue(record['resources']);
      const exclusive = record['exclusive'] === true;
      return {
        name,
        description,
        instructions,
        trust,
        ...(tags.length > 0 ? { tags } : {}),
        ...(resources.length > 0 ? { resources } : {}),
        ...(exclusive ? { exclusive } : {}),
      };
    } catch {
      return undefined;
    }
  }

  /**
   * 同步加载可选 `yaml`（CLI 的 `--skills` 是同步路径）。
   * @returns 解析函数；未安装时为 undefined。
   */
  private static yamlParser(): YamlParse | undefined {
    try {
      const require = createRequire(import.meta.url);
      const mod = require('yaml') as { parse: YamlParse };
      return (input: string) => mod.parse(input);
    } catch {
      return undefined;
    }
  }

  /**
   * 解析 tags 的 YAML 值（数组或字符串）。
   * @param raw 原始值。
   * @returns tags。
   */
  private static tagsOfValue(raw: unknown): string[] {
    if (Array.isArray(raw)) {
      return [
        ...new Set(
          raw.filter((item): item is string => typeof item === 'string').map((item) => item.trim()),
        ),
      ].filter((item) => item !== '');
    }
    return typeof raw === 'string' ? SkillMdCodec.tagsOf(raw) : [];
  }

  /**
   * 序列化为 `SKILL.md` 文本。
   * @param skill 技能条目。
   * @returns frontmatter + 正文。
   */
  public static serialize(skill: SkillEntry): string {
    const lines = ['---', `name: ${skill.name}`, `description: ${skill.description}`];
    if (skill.tags !== undefined && skill.tags.length > 0) {
      lines.push(`tags: [${skill.tags.join(', ')}]`);
    }
    if (skill.resources !== undefined && skill.resources.length > 0) {
      lines.push(`resources: [${skill.resources.join(', ')}]`);
    }
    if (skill.exclusive === true) {
      lines.push('exclusive: true');
    }
    lines.push('---', '', skill.instructions.trim(), '');
    return lines.join('\n');
  }

  /**
   * 解析 tags 字段。
   * @param raw 原始值（`[a, b]` 或 `a,b`）。
   * @returns 去空、去重的 tags。
   */
  private static tagsOf(raw: string | undefined): string[] {
    if (raw === undefined || raw.trim() === '') return [];
    const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '');
    const tags = inner
      .split(',')
      .map((tag) => tag.trim().replace(/^["']|["']$/g, ''))
      .filter((tag) => tag !== '');
    return [...new Set(tags)];
  }
}
