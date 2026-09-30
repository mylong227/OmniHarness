/**
 * @beta
 * 事实表：标识符 → 值。
 */
export type PolicyFacts = Readonly<Record<string, string | number | boolean | readonly string[]>>;
