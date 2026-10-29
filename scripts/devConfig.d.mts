/**
 * devConfig.mjs 的类型声明（TS 侧以 `import ... from '../scripts/devConfig.mjs'` 消费；
 * NodeNext / bundler 解析 `.mjs` 时会找同名 `.d.mts`——见根 tsconfig 的 moduleResolution）。
 */

/** 开发回路的默认地址（唯一的字面量出处；后端侧镜像见 src/cli/serveDefaults.ts）。 */
export interface DevDefaults {
  /** 后端 serve 默认端口。 */
  backendPort: number;
  /** Vite dev server 默认端口。 */
  uiPort: number;
  /** 回环主机（代理目标 / 就绪探针 / 测试夹具监听）。 */
  host: string;
}

/** resolveDevAddress 的返回：端口 / 主机 / 拼好的 origin。 */
export interface DevAddress extends DevDefaults {
  /** 后端 origin：vite proxy 的 target、startAll/devAll 的就绪探针都拼这里。 */
  backendOrigin: string;
  /** Vite dev server origin（提示文案用）。 */
  uiOrigin: string;
}

/** 开发回路的默认地址（唯一字面量出处）。 */
export declare const DEV_DEFAULTS: DevDefaults;

/**
 * 把环境变量叠到默认值上，解析出本次开发回路的完整地址。
 * @param env 环境变量（默认 process.env；测试可注入假环境）。
 */
export declare function resolveDevAddress(env?: Record<string, string | undefined>): DevAddress;
