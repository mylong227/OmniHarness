import type {
  ModelOutput,
  ModelPort,
  ModelRequest,
  StreamCallbacks,
} from '../ports/model/model.js';
import { CancelledError, type CancelReason } from '../core/loop/cancelledError.js';

/** 与父信号联动的一次性信号绑定（dispose 解绑监听，避免长会话上监听器堆积）。 */
interface LinkedSignal {
  /** 转发后的取消信号（父信号或「父∪子」的合并信号）。 */
  readonly signal: AbortSignal;
  /** 解绑监听（请求结束后调用，幂等）。 */
  dispose(): void;
}

/**
 * 把父会话的取消信号并进子代每次模型请求的 `signal`，实现取消的协作式传播。
 *
 * 为什么在模型端口上做，而不是给子代换一个取消令牌：子代是自己那一轮 `Agent` 循环的
 * 拥有者，其取消令牌在 `Agent` 内部创建、外部拿不到句柄；而模型端口是子代 runtime 里
 * **可注入**的那一环——一个装饰器即可让「父取消」直接落到子代每一次在飞 HTTP 请求上，
 * 子代随即抛 CancelledError 收尾（不再继续烧 token），零改动主循环。
 *
 * 语义边界（诚实说明）：本装饰器只中止**模型调用**这一最贵的在飞资源；子代已发出的
 * 工具调用不会被强杀（工具自身若支持 signal 需各自接）。父取消后子代不再发起新请求，
 * 故「不再烧 token」这一核心诉求成立。
 *
 * @param inner 被包装的模型端口（子代原模型）
 * @param parent 父会话取消信号（其 abort 会中断子代在飞请求）
 * @returns 与 inner 同名的模型端口；请求信号已与父信号联动，`stream` 仅在 inner 支持时透出
 */
export function cancellableModel(inner: ModelPort, parent: AbortSignal): ModelPort {
  const wrapped: ModelPort = {
    name: inner.name,
    generate: (request: ModelRequest): Promise<ModelOutput> =>
      withCancel(parent, request.signal, (signal) => inner.generate({ ...request, signal })),
  };
  const stream = inner.stream;
  if (stream === undefined) {
    return wrapped;
  }
  return {
    ...wrapped,
    stream: (request: ModelRequest, callbacks: StreamCallbacks): Promise<ModelOutput> =>
      withCancel(parent, request.signal, (signal) =>
        stream.call(inner, { ...request, signal }, callbacks),
      ),
  };
}

/**
 * 在「父信号 ∪ 子代自有信号」下执行一次模型调用；父已取消则直接拒绝。
 * @param parent 父会话取消信号
 * @param own 子代自有取消信号（可缺省）
 * @param invoke 实际调用（入参为联动后的信号）
 * @returns 模型输出
 * @throws CancelledError 父信号已取消（或在飞请求被父取消中断后由 inner 抛出）
 */
async function withCancel<T>(
  parent: AbortSignal,
  own: AbortSignal | undefined,
  invoke: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (parent.aborted) {
    throw new CancelledError(reasonOf(parent));
  }
  const link = linkSignals(parent, own);
  try {
    return await invoke(link.signal);
  } finally {
    // 请求结束后必须解绑：否则长会话里每个子请求都会在父信号上留一个监听器。
    link.dispose();
  }
}

/**
 * 联动两个取消信号（子信号缺省时直接用父信号；任一已取消则直接返回该信号）。
 * @param parent 父会话取消信号
 * @param own 子代自有取消信号（可缺省）
 * @returns 联动信号与解绑函数
 */
function linkSignals(parent: AbortSignal, own: AbortSignal | undefined): LinkedSignal {
  if (own === undefined || own === parent) {
    return { signal: parent, dispose: () => undefined };
  }
  if (parent.aborted || own.aborted) {
    return { signal: parent.aborted ? parent : own, dispose: () => undefined };
  }
  const controller = new AbortController();
  const forward = (source: AbortSignal): void => {
    controller.abort(source.reason);
  };
  const onParent = (): void => forward(parent);
  const onOwn = (): void => forward(own);
  parent.addEventListener('abort', onParent, { once: true });
  own.addEventListener('abort', onOwn, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      parent.removeEventListener('abort', onParent);
      own.removeEventListener('abort', onOwn);
    },
  };
}

/**
 * 取信号的取消原因（AbortSignal.reason 缺省时为 'user'）。
 * @param signal 已取消的信号
 * @returns 结构化取消原因
 */
function reasonOf(signal: AbortSignal): CancelReason {
  const reason: unknown = signal.reason;
  return reason === 'user' || reason === 'timeout' || reason === 'shutdown' || reason === 'parent'
    ? reason
    : 'parent';
}
