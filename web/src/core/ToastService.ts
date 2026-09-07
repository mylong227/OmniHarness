// 面向对象的服务层：轻提示（toast）的发布者。组件通过 React 状态订阅，
// 这里仅做"消息 → 订阅槽"的解耦，便于在任意位置触发反馈而不污染组件树。

export type ToastKind = 'ok' | 'err' | 'info';

type ToastSink = (message: string, kind: ToastKind) => void;

export class ToastService {
  private sink: ToastSink | null = null;

  /** 由 App 在挂载时绑定到 React 状态，使 toast 真正渲染出来。 */
  bind(sink: ToastSink): void {
    this.sink = sink;
  }

  show(message: string, kind: ToastKind = 'info'): void {
    this.sink?.(message, kind);
  }

  ok(message: string): void {
    this.show(message, 'ok');
  }

  err(message: string): void {
    this.show(message, 'err');
  }
}
