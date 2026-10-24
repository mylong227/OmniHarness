/**
 * `serve` 的 stdin 控制通道（桌面客户端专用，2026-10-24）。
 *
 * 为什么需要：Windows 上 Node 的 `child.kill('SIGTERM')` 等价于强制终止，
 * `ServeShutdown` 收不到可捕获信号，可能丢最后一笔落盘并留下 MCP/后台子进程。
 * 桌面端通过 stdin 发 `{"type":"shutdown"}`，父进程崩溃时管道 EOF 也能触发收尾。
 *
 * 边界：只在 `OMNI_CONTROL_STDIO=1` 时启用；只接受父进程管道，不暴露网络面。
 */
export class ServeControl {
  private constructor() {}

  /**
   * 挂载 stdin 控制通道。
   * @param onShutdown 收到 shutdown / EOF 时的收尾回调。
   * @returns 无返回值。
   */
  public static attach(onShutdown: (reason: string) => void): void {
    if (process.env['OMNI_CONTROL_STDIO'] !== '1') return;
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    let buffer = '';
    process.stdin.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line !== '') {
          try {
            const message = JSON.parse(line) as { type?: unknown };
            if (message.type === 'shutdown') onShutdown('CONTROL');
          } catch {
            // 坏行忽略：控制通道只服务父进程，不因脏数据崩溃。
          }
        }
        index = buffer.indexOf('\n');
      }
    });
    // 父进程退出/崩溃时管道关闭：等同收到 shutdown，保证不留下孤儿。
    process.stdin.on('end', () => onShutdown('STDIN_EOF'));
    process.stdin.on('error', () => onShutdown('STDIN_ERROR'));
  }
}
