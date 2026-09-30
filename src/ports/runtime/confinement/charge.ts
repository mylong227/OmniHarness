/** 多维色荷（整数群元素，运行时 mod 群阶）。 */
export interface Charge {
  /** 色。 */
  readonly color: number;
  /** 味。 */
  readonly flavor: number;
  /** 权限。 */
  readonly permission: number;
  /** 时效。 */
  readonly expiry: number;
}
