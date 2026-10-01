import type { Skill } from './skill.js';

/**
 * **声明式技能子集**：配置文件 / CLI 可注入的字段。
 *
 * 为什么单独一个类型（而不是直接收 `Skill`）：`Skill` 里还挂着莫尔组合元数据
 * （`capabilityField` / `moire` / `frozen` / `frozenFrom`）——那些是**运行时/进化**产物，
 * 由组合器与固化器写入。允许外部配置注入它们等于让配置伪造「这技能是涌现/固化来的」，
 * 越过门禁与准入判定。故配置文件与 CLI 只认这一子集，其余字段由运行时自己写。
 */
export type SkillEntry = Pick<Skill, 'name' | 'description' | 'instructions' | 'tags'>;
