/**
 * `serve` 启动收尾的实例记录/就绪文件/UI 地址输出（从 `CliServerCmds` 外移）。
 *
 * 为什么单独成文件：`cliServerCmds.ts` 已是历史上帝类（>500 行），再把这段塞回去会
 * 触发编码标准增量门禁；外移后 `runHttpServe` 保持可读，也让“桌面就绪契约”有单点实现。
 */
import type { AppServer } from '../server/core/appServer.ts';
import { API_VERSION } from '../version.ts';
import { ServeInstance } from './serveInstance.ts';
import { ServeReadyFile } from './serveReadyFile.ts';

/** 启动收尾结果。 */
export interface AnnounceServeResult {
  /** 实例记录路径（`OMNI_NO_SERVE_INSTANCE=1` 时 undefined）。 */
  readonly instancePath: string | undefined;
  /** 就绪文件路径（未配置 `OMNI_READY_FILE` 时为空串）。 */
  readonly readyPath: string;
}

/** serve 启动收尾（实例记录/就绪文件/UI 地址）。 */
export class ServeAnnounce {
  private constructor() {}

  /**
   * 写入实例记录/桌面就绪文件并打印 UI 地址。
   *
   * @param app 已构造的服务端（取当前工作区）。
   * @param host 实际绑定地址。
   * @param port 实际监听端口。
   * @param token 实际生效的 Token（可能未启用）。
   * @param configuredToken 显式配置的 Token（空串表示临时 Token）。
   * @param manageInstance 是否写 `~/.omniharness/serve-*.pid`。
   * @returns 实例记录路径与就绪文件路径。
   */
  public static announce(
    app: AppServer,
    host: string,
    port: number,
    token: string | undefined,
    configuredToken: string,
    manageInstance: boolean,
  ): AnnounceServeResult {
    // 绑定成功后才写记录（先写会留下"说要跑但没跑起来"的假记录）。
    const instancePath = manageInstance
      ? ServeInstance.announce({
          pid: process.pid,
          host,
          port,
          startedAt: new Date().toISOString(),
          workspace: app.effectiveWorkspace(),
          version: API_VERSION,
        })
      : undefined;
    // 桌面端就绪文件：只含端口/pid/工作区/版本，**不含 Token**。
    const readyPath = (process.env['OMNI_READY_FILE'] ?? '').trim();
    if (readyPath !== '') {
      ServeReadyFile.write(readyPath, {
        protocol: 1,
        pid: process.pid,
        host,
        port,
        workspace: app.effectiveWorkspace(),
        apiVersion: API_VERSION,
        harnessVersion: API_VERSION,
        startedAt: new Date().toISOString(),
      });
    }
    const authNote =
      token === undefined
        ? '（未启用鉴权；仅回环可访问）'
        : configuredToken !== ''
          ? '（已启用 Bearer 鉴权）'
          : '（已启用本机临时令牌；请用下面的带 token URL 打开）';
    const uiUrl =
      token === undefined
        ? `http://${host}:${port}`
        : `http://${host}:${port}/?token=${encodeURIComponent(token)}`;
    if (process.env['OMNI_NO_UI_URL'] === '1') {
      // 桌面端自己拼带 Token 的 URL；绝不把 Token 打进侧车 stdout/日志。
      process.stdout.write(`OmniHarness UI: http://${host}:${port}（Token 已抑制）\n`);
    } else {
      process.stdout.write(`OmniHarness UI: ${uiUrl} ${authNote}\n`);
    }
    return { instancePath, readyPath };
  }
}
