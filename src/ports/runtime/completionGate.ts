/**
 * 回合**完成闸门**端口（2026-09-26 审计 A1；2026-09-27 从 `core/turnRunner` 下沉）。
 *
 * 为什么需要它：自验证回环此前只是**信号**（把失败摘要追加进工具结果），模型完全可以无视它
 * 直接输出结论收尾 —— 产品路径上没有任何东西阻止「改坏了代码还宣布完成」。
 * 本接口把「本会话最近一次对源码改动的验证结果」暴露给 `TurnRunner`：仍有失败则回灌并再给一步。
 *
 * 两种实现（`kind` 决定触发条件）：
 *  - `'status'`：读写时自验证的**已有结论**（零额外开销，任何时机都可问）；
 *  - `'turn-end'`：在回合末尾**现跑一次**验证命令（因此只在「本回合确实改过文件」时才问，
 *    否则纯问答回合也会平白跑一次测试）。
 *
 * **为何在 ports 而非 core**：合同类型原先声明在 `core/turnRunner.ts`，于是选实现的适配器
 * （`adapters/tool/verify/turnCompletionGateFactory`）必须 import core 具体模块、组合根又必须
 * 让 core 反向 import 适配器——一次接线踩出两条 `adapters→core` / `core→adapters` 架构违规。
 * 契约下沉到端口后，core 只依赖端口、适配器实现端口、组合根（`composition/`）注入，方向向内。
 *
 * 端口纯度：本文件只有接口与类型别名（无 class、无第三方裸导入）。
 *
 * 本文件已退化为桶：4 个接口各自独立成文件于 `./completionGate/`，调用点零改动。
 */

export type { CompletionGate } from './completionGate/completionGate.js';
export type { CompletionGateContext } from './completionGate/completionGateContext.js';
export type { CompletionGateSelfVerifyConfig } from './completionGate/completionGateSelfVerifyConfig.js';
export type { CompletionGateFactory } from './completionGate/completionGateFactory.js';
