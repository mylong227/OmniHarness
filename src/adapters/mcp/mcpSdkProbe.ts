/**
 * MCP 官方 SDK 可用性探测（MCP SDK availability probe）。
 *
 * 动机（A1 接线）：`sdkMcpServerAdapter` 是**可选增强路径**——SDK 不可用时必须回落既有手写
 * `src/mcp/*` 实现，并**如实打印回落原因**（绝不静默降级）。本探测把「可用性 + 不可用原因」
 * 收成一处，供 `mcp serve` 与单测共用。
 *
 * 探测口径（**按真实用到的子路径逐条实载**，不依赖包根入口）：
 *   - adapter 需要 `server/mcp.js`（McpServer）、`inMemory.js`（InMemoryTransport）、
 *     `client/index.js`（Client）；stdio 部署还需要 `server/stdio.js`（StdioServerTransport）。
 *   - 之所以不用 `import('<pkg>')`：包根 `dist/esm/index.js` 可能未随包发布，而子路径
 *     完全可用（本机实测就是这种形态）。按包根判定会把「其实能用」误判为不可用，
 *     白白回落到手写实现——那才是真正的不如实。
 *   - 每条失败都带上具体模块名与错误消息，回落日志因此可自查。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** SDK 库名（准入清单声明的落点层为 src/adapters/mcp，见 dependency-allowlist.json）。 */
const SDK_PACKAGE = '@modelcontextprotocol/sdk';

/** 探测所需模块（相对 SDK 包的子路径；与适配器/部署形态的真实导入路径逐字一致）。 */
const REQUIRED = ['server/mcp.js', 'inMemory.js', 'client/index.js', 'server/stdio.js'] as const;

/** 单条模块装载结果。 */
export interface McpSdkModuleResult {
  /** 相对 SDK 包的子路径（如 `server/mcp.js`）。 */
  readonly specifier: string;
  /** 是否实载成功。 */
  readonly ok: boolean;
  /** 失败原因；成功时 undefined。 */
  readonly reason?: string | undefined;
}

/** SDK 可用性探测结果。 */
export interface McpSdkProbeResult {
  /** 是否可用（全部必需模块可实载）。 */
  readonly available: boolean;
  /** 解析到的包版本；不可用（未安装）时 undefined。 */
  readonly version?: string | undefined;
  /** 不可用原因（人类可读短句）；可用时为 undefined。 */
  readonly reason?: string | undefined;
  /** 逐模块装载明细（可用时也给出，便于日志核对版本形态）。 */
  readonly modules: readonly McpSdkModuleResult[];
}

/**
 * 官方 MCP SDK 可用性探测器（静态方法族，无实例状态）。
 */
export class McpSdkProbe {
  /**
   * 探测 SDK 是否可加载（逐条实载适配器真正用到的子路径）。
   * @returns 可用性 + 版本 + 不可用原因 + 逐模块明细
   */
  public static async check(): Promise<McpSdkProbeResult> {
    const versionPath = McpSdkProbe.resolvePackageJson();
    const modules = await Promise.all(REQUIRED.map((specifier) => McpSdkProbe.load(specifier)));
    const version = versionPath === undefined ? undefined : McpSdkProbe.versionOf(versionPath);
    return McpSdkProbe.assemble(modules, version, versionPath !== undefined);
  }

  /**
   * 汇总逐模块结果。
   * @param modules 逐模块装载结果
   * @param version 包版本（可缺省）
   * @param installed 包声明是否可解析
   * @returns 探测结果（含失败原因汇总）
   */
  private static assemble(
    modules: readonly McpSdkModuleResult[],
    version: string | undefined,
    installed: boolean,
  ): McpSdkProbeResult {
    const failed = modules.filter((entry) => !entry.ok);
    if (failed.length === 0) {
      return { available: true, modules, ...(version !== undefined ? { version } : {}) };
    }
    const head = installed ? `${SDK_PACKAGE} 模块实载失败` : `未安装依赖包 ${SDK_PACKAGE}`;
    const detail = failed
      .map((entry) => `${entry.specifier}: ${entry.reason ?? '未知原因'}`)
      .join('；');
    return { available: false, reason: `${head}（${detail}）`, modules };
  }

  /**
   * 实载单个 SDK 子路径。
   * @param specifier 相对 SDK 包的子路径
   * @returns 该模块的装载结果
   */
  private static async load(specifier: string): Promise<McpSdkModuleResult> {
    try {
      await import(`${SDK_PACKAGE}/${specifier}`);
      return { specifier, ok: true };
    } catch (error) {
      return { specifier, ok: false, reason: McpSdkProbe.messageOf(error) };
    }
  }

  /**
   * 解析 SDK 的 package.json 绝对路径。
   *
   * 不能用 `import.meta.resolve('@modelcontextprotocol/sdk/package.json')`：SDK 的 exports
   * 有 `./*` 通配，Node 会把 `package.json` 当子路径重写成 `dist/esm/package.json`（实测该
   * 文件只是 `{"type":"module"}` 的残件——版本号会取到空）。故从包根入口上溯，取第一个
   * **`name` 字段等于包名**的 package.json（按内容判定，不按目录名猜作用域包的层级）。
   * @returns 绝对路径；解析失败（未安装 / 环境无 import.meta.resolve）时 undefined
   */
  private static resolvePackageJson(): string | undefined {
    const meta = import.meta as { resolve?: (specifier: string) => string };
    if (meta.resolve === undefined) {
      return undefined;
    }
    let start: string;
    try {
      start = fileURLToPath(meta.resolve(SDK_PACKAGE));
    } catch {
      return undefined;
    }
    let dir = dirname(start);
    for (let depth = 0; depth < 8; depth += 1) {
      const candidate = join(dir, 'package.json');
      if (McpSdkProbe.nameOf(candidate) === SDK_PACKAGE) {
        return candidate;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        return undefined;
      }
      dir = parent;
    }
    return undefined;
  }

  /**
   * 读取某个 package.json 的 `name` 字段。
   * @param packageJsonPath 候选 package.json 路径
   * @returns 包名；文件缺失 / 不可解析 / 无 name 时 undefined
   */
  private static nameOf(packageJsonPath: string): string | undefined {
    if (!existsSync(packageJsonPath)) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: unknown };
      return typeof parsed.name === 'string' ? parsed.name : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 读取包版本号。
   * @param packageJsonPath SDK 的 package.json 绝对路径
   * @returns 版本号；文件不可读 / 无 version 字段时 undefined
   */
  private static versionOf(packageJsonPath: string): string | undefined {
    try {
      const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
      return typeof parsed.version === 'string' ? parsed.version : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 提取错误消息。
   * @param error 任意抛出值
   * @returns Error 取 message，其余 String() 化
   */
  private static messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
