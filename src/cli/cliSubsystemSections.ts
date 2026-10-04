/**
 * 可选**子系统段**映射：CLI 参数 → `OmniHarnessConfig` 的可选子系统片段。
 *
 * ## 为什么单独成类（而不是 `CliBuildConfig` 的一个私有方法）
 *
 * 这些段落的共同语义是「**未显式配置就不写 `partial`** = 零行为变更」——写进去就意味着
 * 组合根会去构造对应的运行时件（进化控制器 / A2aServer / 媒体抽帧栈）。把它们留在
 * `buildConfig` 的字面量里有两个代价：① 每段都带一组「可选项条件展开」
 * （`...(x !== undefined ? {k: x} : {})`），会把那个已经很长的函数推过体量红线；
 * ② 「哪些子系统是选择性的」这件事被淹没在必填字段之间。
 *
 * 但**不能**把它加成 `CliBuildConfig` 的成员方法：那个类的方法数已经贴着
 * 「单类 ≤ 25 方法」的上帝类红线（`scripts/check.mjs` 的 GOD CLASSES 判据），
 * 再加一个方法即刻越线。故按「一文件一类、一类一个功能点」另起本类。
 *
 * ## 新增同类子系统时怎么做
 *
 * 在 {@link CliSubsystemSections.of} 的返回字面量里追加一段，条件形式统一为
 * `...(条件 ? { 段: {...} } : {})`；不要在段里写 `undefined`（那会让组合根拿到一个
 * 存在但为空的配置对象，进而以为「用户配了这个子系统」）。
 */

import type { CliArgs } from './argParser.js';
import type { OmniHarnessConfig } from '../ports/config/omniHarnessConfig.js';

/** 可选子系统段映射器（无状态，纯函数式）。 */
export class CliSubsystemSections {
  /**
   * 把 CLI 参数里的可选子系统映射成 `partial` 片段。
   *
   * 当前覆盖三段：
   * - **(U4) RLVR 进化闭环**（`--evolution-rlvr` 及其子旗标）：未给 `--rlvr-verify` 时
   *   `verifyCommand` 缺省 ⇒ RLVR 奖励恒 0（无绿样本进回放，fail-closed 安全旁路）。
   * - **(U6) A2A 互操作**（`--a2a` 及其子旗标）：缺省不起监听、不连对端。
   * - **媒体抽帧**（配置文件 `media` 段，`view_media` 工具）：整段透传，结构与编程注入
   *   同一份；不写时 `MediaConfigResolver` 仍给出全默认并收敛 ⇒ 与「显式写了默认值」等价。
   *
   * @param args 解析后的 CLI 参数。
   * @returns 需并入 `partial` 的可选段；**未配置的段不出现**（而不是出现为 `undefined`）。
   */
  public static of(args: CliArgs): Partial<OmniHarnessConfig> {
    return {
      ...(args.evolutionRlvr === true
        ? {
            evolutionRlvr: {
              enabled: true,
              ...(args.rlvrVerify !== undefined ? { verifyCommand: args.rlvrVerify } : {}),
              ...(args.rlvrSamples !== undefined ? { samplesPerPrompt: args.rlvrSamples } : {}),
              ...(args.rlvrMinReward !== undefined ? { minReward: args.rlvrMinReward } : {}),
              ...(args.rlvrCandidates !== undefined ? { maxCandidates: args.rlvrCandidates } : {}),
              ...(args.rlvrMinGain !== undefined ? { minGain: args.rlvrMinGain } : {}),
              autoRun: args.rlvrAutoRun === true,
              // （GEE Kernel v1）Kernel 子键透传（缺省不带 = 默认关，零行为变更）。
              ...(args.evolutionKernel === true ? { kernel: true } : {}),
              ...(args.rlvrLedgerDir !== undefined ? { ledgerDir: args.rlvrLedgerDir } : {}),
              ...(args.rlvrArchiveMax !== undefined
                ? { archiveMaxPerBucket: args.rlvrArchiveMax }
                : {}),
            },
          }
        : {}),
      ...(args.a2a === true
        ? {
            a2a: {
              enabled: true,
              ...(args.a2aPort !== undefined ? { port: args.a2aPort } : {}),
              ...(args.a2aPeer !== undefined ? { peerEndpoint: args.a2aPeer } : {}),
              ...(args.a2aTransport !== undefined ? { transport: args.a2aTransport } : {}),
            },
          }
        : {}),
      ...(args.media !== undefined ? { media: args.media } : {}),
      // （Wave B · ADR-0009）统一资产协议段：整段透传（结构同一份；字段校验已在配置文件归一化
      // 阶段 fail-closed 完成）。未配置则不出现该段 ⇒ `capability.enabled !== true` ⇒ 零行为变更。
      ...(args.capability !== undefined ? { capability: args.capability } : {}),
      // （F3 RBAC-lite）角色门禁段：整段透传（结构同一份；严格校验已在配置文件归一化阶段完成）。
      // 未配置则不出现该段 ⇒ 运行时 `rbac.enabled !== true` ⇒ 不注入角色门禁（零行为变更）。
      ...(args.rbac !== undefined ? { rbac: args.rbac } : {}),
    };
  }
}
