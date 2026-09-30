/**
 * 媒体（动画 GIF / 视频）契约词汇表 —— 端口层单一来源。
 *
 * ## 为什么需要这一层
 *
 * 在此之前，OmniHarness 对「动的东西」只有一条能力：把整份字节当**一张静态图**塞给模型
 * （`view_image` + `ImageProbe`）。对动画 GIF 与视频，这等于**只看第一帧**：
 * 压缩后的单张字节既丢掉了时间维（动作、转场、状态迁移），又常常体积巨大而被上限直接拒绝。
 * 用户要的「一帧一帧拆开理解」在数据通道上根本不存在。
 *
 * ## 为什么在 `ports/`
 *
 * 消费方横跨 `adapters/tool/media`（工具）、`adapters/media`（提取器）、`config`（装配）。
 * 端口层是唯一共同下游，且本文件只有**类型**（无 class、无第三方、无逻辑），符合端口纯度门禁。
 *
 * ## 术语
 *
 * - **探测（probe）**：只读元数据（时长 / 尺寸 / 帧率 / 帧数 / 编码），不解码像素。
 * - **提取（extract）**：把源按采样策略解成**若干张 PNG 帧**，供模型逐帧判读。
 * - **帧（frame）**：一张已编码的图片 + 它在源中的时间点，二者必须同时交付——
 *   只给图不给时间是「看图猜顺序」，模型无法描述「先发生什么、后发生什么」。
 *
 * 本文件已退化为桶：5 个接口各自独立成文件于 `./mediaTypes/`，调用点零改动。
 */

export type { MediaKind } from './mediaTypes/mediaKind.js';
export type { FrameStrategy } from './mediaTypes/frameStrategy.js';
export type { MediaProbeInfo } from './mediaTypes/mediaProbeInfo.js';
export type { MediaFrame } from './mediaTypes/mediaFrame.js';
export type { FrameSelectionPolicy } from './mediaTypes/frameSelectionPolicy.js';
