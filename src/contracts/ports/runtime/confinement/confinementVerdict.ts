/** 暴露裁决。 */
export interface ConfinementVerdict {
  /** 能力 ID。 */
  readonly id: string;
  /** 是否可暴露（仅单态为 true）。 */
  readonly exposed: boolean;
  /** 理由。 */
  readonly reason: string;
}
