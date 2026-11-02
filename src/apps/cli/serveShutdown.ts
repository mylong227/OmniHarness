import type { HttpServer } from '../server/transport/httpServer.ts';
import { ServeInstance } from './serveInstance.ts';
import { ServeControl } from './serveControl.ts';

/**
 * `serve` 的 SIGINT/SIGTERM/stdin 控制收尾（2026-10-21 从 `CliServerCmds.awaitShutdown` 拆出）。
 *
 * 顺序有讲究：先在飞回合取消并等待落盘，再断连接/关监听。反过来的话，
 * EventPersister 的 write-behind 最后一步与回合末 flush 都会被掐断。
 * 抽成独立类还有一个机械原因：`CliServerCmds` 已贴着「上帝类」代码行数门禁。
 */
export class ServeShutdown {
  /**
   * 常驻等待信号/控制命令并优雅收尾。
   * @param server 已启动的 HTTP 服务。
   * @param instancePath 本实例记录文件（收尾时只删自己的那条；桌面模式可不传）。
   * @param beforeClose 关服务器前的收尾（取消在跑回合并等待落盘）；失败不阻断关服。
   * @returns 关闭完成后 resolve（调用方据此正常退出）。
   */
  public static wait(
    server: HttpServer,
    instancePath?: string,
    beforeClose?: () => Promise<void>,
  ): Promise<number> {
    return new Promise<number>((resolve) => {
      let closing = false;
      const shutdown = (reason: string): void => {
        if (closing) return;
        closing = true;
        process.stdout.write(`\n收到 ${reason}，正在关闭服务…\n`);
        void (async () => {
          try {
            await beforeClose?.();
          } catch {
            // 收尾失败不阻断关服（进程仍要退出）。
          }
          await server.close().catch(() => undefined);
          // 正常退出即退役记录；异常退出留下的记录由下次启动清扫（见 `ServeInstance.sweep`）。
          if (instancePath !== undefined) ServeInstance.retire(instancePath);
          resolve(0);
        })();
      };
      process.once('SIGINT', () => shutdown('SIGINT'));
      process.once('SIGTERM', () => shutdown('SIGTERM'));
      // 桌面端 stdin 控制通道：Windows 没有可捕获的优雅信号，父进程 EOF 也要能收尾。
      ServeControl.attach(shutdown);
    });
  }
}
