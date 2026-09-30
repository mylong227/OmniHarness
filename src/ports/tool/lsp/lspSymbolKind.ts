/**
 * @beta
 * 文档符号种类的人类可读名（对齐 LSP `SymbolKind` 数值）。
 *
 * 为什么不直接暴露数值：模型看到 `kind: 12` 无从判断这是函数还是变量，
 * 而符号查询的全部价值就在于「一眼看出这个文件里有什么、长什么样」。
 * 未知数值回落 `symbol#<n>` 而**不丢信息**——宁可显示得笨一点，也不假装认识。
 */
export type LspSymbolKind =
  | 'file'
  | 'module'
  | 'namespace'
  | 'package'
  | 'class'
  | 'method'
  | 'property'
  | 'field'
  | 'constructor'
  | 'enum'
  | 'interface'
  | 'function'
  | 'variable'
  | 'constant'
  | 'string'
  | 'number'
  | 'boolean'
  | 'array'
  | 'object'
  | 'key'
  | 'null'
  | 'enum-member'
  | 'struct'
  | 'event'
  | 'operator'
  | 'type-parameter'
  | `symbol#${number}`;
