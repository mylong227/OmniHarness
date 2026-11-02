/**
 * serve 的**默认地址常量**——后端侧字面量的唯一出处（2026-10-30 收口，看板 §182）。
 *
 * 为什么要一个文件：`8787` 之前散在 cliServerCmds / cliIdentityDaemonCmds / 前端
 * scripts/lib/launchReadiness.mjs（后者还是自声明"不得自成一源"的镜像）——改一次默认端口要
 * 人肉找齐三处。现在：
 *   · 后端默认端口/覆盖环境变量在这里（`serve --port` 旗标仍最高优先）；
 *   · 前端 dev 工具读 `scripts/devConfig.mjs`（其默认值镜像本文件，一致性由
 *     `tests/unit/devAddressContract.test.ts` 钉死）；
 *   · 绑定主机不在这里：`ServerAuthGuard.DEFAULT_HOST` + `OMNI_SERVE_HOST` 已是单一事实源。
 */
export class ServeDefaults {
  /** serve 的默认端口（`--port` 旗标 > `OMNI_BACKEND_PORT` 环境变量 > 本值）。 */
  public static readonly DEFAULT_SERVE_PORT = 8787;

  /**
   * 解析 serve 的默认端口：`OMNI_BACKEND_PORT` 环境变量可覆盖默认值。
   *
   * 为什么读开发工具同名环境变量：`npm run dev` / `npm start` 与 vite 代理共用
   * `OMNI_BACKEND_PORT`——一处设置，后端监听与前端代理同时改，杜绝"两边默认值漂移"。
   * @param env 环境变量（默认 process.env；测试可注入）。
   * @returns 端口号。
   */
  public static resolveDefaultPort(env: NodeJS.ProcessEnv = process.env): number {
    const raw = (env['OMNI_BACKEND_PORT'] ?? '').trim();
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : ServeDefaults.DEFAULT_SERVE_PORT;
  }
}
