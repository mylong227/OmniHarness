/**
 * 开发回路地址**唯一事实源**（2026-10-30 收口，看板 §182）。
 *
 * ## 为什么需要它
 *
 * vite.config 的 proxy 目标、devAll/startAll 起的 serve 端口、就绪探针 URL、测试夹具的回环地址
 * 曾经各自写死 `8787` / `5173` / `127.0.0.1`——两边默认值只是"碰巧一致"：设了
 * `OMNI_BACKEND_PORT=9000` 时 vite 代理到 9000、serve 仍在 CLI 默认 8787，开发回路直接断裂。
 * 现在所有消费者都从这里取值，环境变量只在这里解释一次。
 *
 * ## 环境变量（全部可选）
 *
 *   · `OMNI_BACKEND_PORT`：后端 serve 端口（后端侧同读它，见 `src/cli/serveDefaults.ts`）；
 *   · `OMNI_UI_PORT`：Vite dev server 端口（别名 `OMNI_FRONTEND_PORT`——devAll 旧文档用名，收编）；
 *   · `OMNI_DEV_HOST`：回环主机（代理目标 / 就绪探针 / 测试夹具监听）。后端自身的绑定地址
 *     仍由 `OMNI_SERVE_HOST`（ServerAuthGuard）管理——那是"产品绑在哪"，这里是"开发工具连哪"。
 *
 * ## 与后端默认值的关系
 *
 * 本文件的 backendPort 默认值**镜像** `src/cli/serveDefaults.ts` 的 `DEFAULT_SERVE_PORT`
 * （node 脚本无法 import 后端 TS）。镜像一致性由结构判据钉死：
 * `tests/unit/devAddressContract.test.ts`。改默认端口要两处同改（判据会红着提醒）。
 */

/** 开发回路的默认地址（唯一的字面量出处；后端侧镜像见 serveDefaults.ts）。 */
export const DEV_DEFAULTS = Object.freeze({
  /** 后端 serve 默认端口（镜像 `src/cli/serveDefaults.ts` 的 DEFAULT_SERVE_PORT）。 */
  backendPort: 8787,
  /** Vite dev server 默认端口。 */
  uiPort: 5173,
  /** 回环主机：代理目标 / 就绪探针 / 测试夹具监听共用（serve 只绑回环，且 localhost 在
   * Windows 上可能先解析到 ::1 连不上——见 launchReadiness.mjs 的同款注释）。 */
  host: '127.0.0.1',
});

/**
 * 把环境变量叠到默认值上，解析出本次开发回路的完整地址。
 * @param env 环境变量（默认 process.env；测试可注入假环境）。
 * @returns 端口 / 主机 / 拼好的 origin（backendOrigin 给代理目标与探针，uiOrigin 给提示文案）。
 */
export function resolveDevAddress(env = process.env) {
  const readPort = (raw, fallback) => {
    const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const backendPort = readPort(env['OMNI_BACKEND_PORT'] ?? '', DEV_DEFAULTS.backendPort);
  const uiPort = readPort(
    env['OMNI_UI_PORT'] ?? env['OMNI_FRONTEND_PORT'] ?? '',
    DEV_DEFAULTS.uiPort,
  );
  const host = String(env['OMNI_DEV_HOST'] ?? '').trim() || DEV_DEFAULTS.host;
  return {
    backendPort,
    uiPort,
    host,
    /** 后端 origin：vite proxy 的 target、startAll/devAll 的就绪探针都拼这里。 */
    backendOrigin: `http://${host}:${String(backendPort)}`,
    /** Vite dev server origin（提示文案用）。 */
    uiOrigin: `http://${host}:${String(uiPort)}`,
  };
}
