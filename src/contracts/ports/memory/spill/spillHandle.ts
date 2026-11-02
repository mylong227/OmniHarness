/** 外溢句柄：被移出模型上下文的完整内容的定位信息。 */
export interface SpillHandle {
  readonly id: string;
  readonly bytes: number;
}
