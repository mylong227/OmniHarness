/**
 * 子智能体端口种子（**端口契约**，G25-b/2026-10-03 从 `config/configFactory.ts` 迁入）。
 *
 * 为什么类型要住在 ports：`configBuilder` 与 `configToolRegistry` 需要它来装配工具集，
 * 类型若留在 `configFactory.ts`，这两个文件就得反向 import `configFactory` ⇒ 配置子环
 * （架构门禁 [5] 的第 6 组）。把契约搬进 ports 后，依赖方向重新变成单向：
 * `configFactory → {configBuilder, configToolRegistry, corePortsAssembler}` 与 `corePortsAssembler → configBuilder`。
 */

import type { MediaStack } from '../media/mediaStack.js';
import type { SubagentPortsShape } from '../subagent/subagentPortsShape.js';
import type { SubagentOptions } from '../subagent/subagentOptions.js';

/** 子智能体端口种子（缺 tools，待注册表构造完成后回填）。 */
export type SubagentPortSeed = Omit<SubagentPortsShape, 'tools'> & {
  /** 子智能体选项（模型 / 预算 / 工具白名单上限等）。 */
  readonly subagent: SubagentOptions;
  /** 自主目标循环默认最大迭代次数（#S30，供 run_goal 工具读取）。 */
  readonly goalMaxIterations: number;
  /**
   * 已装配的媒体抽帧栈（动画 GIF / 视频的逐帧判读）。
   *
   * 为什么放在种子里而不是让工具自己 new：`view_media` 同一份栈要同时喂给主会话工具集与
   * 子代工具集（`defaultTools` 两个调用路径共用本种子）——各自装配会得到**两个独立的
   * ffmpeg 定位缓存**（多跑一遍 `-version`）与两套可能漂移的预算口径。
   * 种子本就是「装配工具集所需的一切」的收口（`spill` / `events` / `workspaceRoot` 同理）。
   */
  readonly media: MediaStack;
};
