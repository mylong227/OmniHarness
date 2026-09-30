import type { CompletionGateContext } from './completionGateContext.js';
import type { CompletionGate } from './completionGate.js';

/**
 * 闸门工厂端口：由组合根注入实现，core 只调用不实现。
 * @param context 装配闸门所需的运行期事实。
 * @returns 选中的闸门；无可用闸门（显式退出 / 探测不到命令）时为 undefined。
 */
export type CompletionGateFactory = (context: CompletionGateContext) => CompletionGate | undefined;
