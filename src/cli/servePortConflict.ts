/**
 * `serve` 端口冲突的**诊断与显式接管**（2026-10-11）。
 *
 * ## 为什么需要它（实测教训）
 *
 * `serve` 绑定失败时原先只把 Node 的 `listen EADDRINUSE: address already in use 127.0.0.1:8787`
 * 原样抛给用户。实测后果：一个两天前启动的旧 `serve`（后台活了 48 小时）占着 8787，
 * 于是**每次** `npm start` 都只回这一句——用户既不知道占用者是谁、也不知道让路的三条路，
 * 只能反复重试。这不是"运气不好"，是**报错信息不可行动**。
 *
 * ## 设计（默认安全，接管必须显式）
 *
 * 1. `probe()`：跨平台、零依赖——直接问占用者的 `/healthz`（本服务自己的健康面已带 `pid`）。
 *    能解析出 `{status:'ok', pid}` 即判定为**另一个 OmniHarness serve**；有响应但不符合该形状
 *    即判定为**非本程序的占用者**；连不上即**端口空闲**。
 * 2. `advice()`：把三条出路一次讲清（换端口 / 停掉那个 PID / `--take-port` 显式接管）。
 *    对"非本程序占用者"**不提供**接管——那是别人的进程，本程序无权杀。
 * 3. `takeOver()`：**只在确认是 OmniHarness serve 且拿到正整数 PID 时**才终止它，并等端口真正释放。
 *    默认**不**启用；由 `--take-port` 显式请求。
 *
 * 三者都是纯逻辑 + 可注入依赖（fetch / kill / 等待），因此判据不必真起服务就能覆盖分类与拒绝路径；
 * 真起服务的端到端接线另有一条判据（`servePortConflictE2E.test.ts`）。
 */

import { ServeInstance, type ServeInstanceRecord } from './serveInstance.js';

/** 端口占用者分类。 */
export type PortHolderKind = 'free' | 'omni' | 'foreign';

/** 端口占用者信息。 */
export interface PortHolder {
  /** `free` 无人占用 ｜ `omni` 是另一个 OmniHarness serve ｜ `foreign` 是别的程序。 */
  readonly kind: PortHolderKind;
  /** 占用者 PID（仅 `omni` 时有值）。 */
  readonly pid?: number | undefined;
  /** 占用者已运行秒数（仅 `omni` 时有值，来自健康体）。 */
  readonly uptimeSeconds?: number | undefined;
  /** 人可读的补充说明（诊断/判据用，不参与判定）。 */
  readonly detail: string;
}

/** 可注入依赖（判据用假实现，生产用默认值）。 */
export interface ServePortConflictDeps {
  /** fetch 实现（默认全局 fetch）。 */
  readonly fetchImpl?: typeof fetch | undefined;
  /** 终止进程（默认 process.kill(pid, 'SIGTERM')）。 */
  readonly kill?: ((pid: number) => void) | undefined;
  /** 等待端口释放（默认轮询 probe；判据可注入）。 */
  readonly waitFree?: ((port: number) => Promise<boolean>) | undefined;
  /** 探针超时（毫秒，默认 1500）。 */
  readonly timeoutMs?: number | undefined;
}

/** 端口冲突诊断器。 */
export class ServePortConflict {
  /**
   * 问一次占用者的 `/healthz`，判定端口占用者是谁。
   *
   * 判定口径（fail-closed 取向）：**只有**拿到 `status==='ok'` 且 `pid` 为正整数的健康体，
   * 才算"是自己人"；其余一切响应（含 4xx/5xx、非法 JSON、缺 pid）都按"别人的进程"处理——
   * 宁可给一句"请自己让路"，也**不**去杀一个没能确认身份的进程。
   *
   * @param port 目标端口。
   * @param deps 可注入依赖（fetch / 超时）。
   * @returns 占用者分类与说明。
   */
  public static async probe(port: number, deps: ServePortConflictDeps = {}): Promise<PortHolder> {
    const doFetch = deps.fetchImpl ?? globalThis.fetch;
    const timeoutMs = deps.timeoutMs ?? 1500;
    const url = `http://127.0.0.1:${String(port)}/healthz`;
    /** 只有"连不上"才算空闲；**收到响应**一律说明端口有人占。 */
    let response: Response;
    try {
      response = await doFetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        // 健康面是公开的（容器探针用），不带凭据。
      } as RequestInit);
    } catch (error) {
      // 连不上（ECONNREFUSED / 超时）⇒ 端口空闲。注意：这里**不能**把"超时"当成"别人的进程"，
      // 否则慢启动的自检会误判；空闲是更保守的结论（随后真正的 listen 会给出最终答案）。
      return {
        kind: 'free',
        detail: `连不上 ${url}：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!response.ok) {
      return { kind: 'foreign', detail: `/:${String(port)}/healthz 回 ${String(response.status)}` };
    }
    // 收到响应但body不是 JSON ⇒ **仍是有人占用**（例如别的 HTTP 服务恰好也在 8787）。
    // 首版把这一步也放进上面的 catch ⇒ 非 JSON 被误判成 free（判据当场抓到）。
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      return { kind: 'foreign', detail: '/healthz 有响应但不是 JSON' };
    }
    const body = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const pid = body['pid'];
    if (body['status'] === 'ok' && typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
      const uptime = body['uptimeSeconds'];
      return {
        kind: 'omni',
        pid,
        uptimeSeconds: typeof uptime === 'number' ? uptime : undefined,
        detail: `健康体自述 pid=${String(pid)}`,
      };
    }
    return {
      kind: 'foreign',
      detail: '/healthz 有响应但不是本程序的健康体（缺 status=ok 或 pid）',
    };
  }

  /**
   * 生成可行动的提示（三条出路一次讲清）。
   * @param port 目标端口。
   * @param holder 占用者信息。
   * @param record 该端口的**实例记录**（`serve-<port>.pid`，2026-10-15 增；缺省＝无记录）。
   *   它补的是健康体问不到的那半：**上一个跑在这台机器上的 serve 是谁、什么时候起的、在哪个工作区**。
   *   给了就如实转述，并**明说与健康体的一致/不一致**——不一致时以健康体为准，绝不替记录圆场。
   * @returns 多行提示文本。
   */
  public static advice(
    port: number,
    holder: PortHolder,
    record?: ServeInstanceRecord | undefined,
  ): string {
    const head =
      holder.kind === 'omni'
        ? `端口 ${String(port)} 已被**另一个 OmniHarness serve** 占用` +
          `（PID ${String(holder.pid ?? '?')}${
            holder.uptimeSeconds === undefined
              ? ''
              : `，已运行 ${String(Math.round(holder.uptimeSeconds / 60))} 分钟`
          }）。`
        : `端口 ${String(port)} 被**非本程序的进程**占用（${holder.detail}）。`;
    const lines = [head];
    if (record !== undefined) {
      const described = ServeInstance.describe(record);
      if (holder.kind === 'omni' && holder.pid !== undefined && record.pid !== holder.pid) {
        lines.push(
          `  ⚠️ 实例记录与健康体**不一致**：记录 ${described}，健康体说占用者是 PID ${String(holder.pid)}` +
            '（以健康体为准；记录文件可能属于更早的实例）',
        );
      } else if (holder.kind === 'omni') {
        lines.push(`  实例记录：${described}`);
      } else {
        lines.push(
          `  该端口留有实例记录：${described}（但健康体表明占用者不是本程序 ⇒ 以健康体为准）`,
        );
      }
    } else if (holder.kind === 'omni') {
      lines.push('  该实例没有留下记录文件（旧版本启动，或记录已被清理）');
    }
    lines.push('三条出路：');
    lines.push(
      `  ① 换端口启动：omniharness serve --port ${String(port + 1)}（或 npm start -- --port ${String(port + 1)}）`,
    );
    if (holder.kind === 'omni' && holder.pid !== undefined) {
      lines.push(
        `  ② 停掉那个旧服务：${
          process.platform === 'win32'
            ? `Stop-Process -Id ${String(holder.pid)}`
            : `kill ${String(holder.pid)}`
        }`,
      );
      lines.push(
        `  ③ 让本次启动直接接管：omniharness serve --take-port` +
          `（**仅当占用者确认是 OmniHarness serve 时**才终止它；本程序不会杀别的进程）`,
      );
    } else {
      lines.push('  ② 找出占用者并让它让路（本程序不会终止非自己的进程）');
      if (process.platform === 'win32') {
        lines.push(
          `     Get-NetTCPConnection -LocalPort ${String(port)} -State Listen | Select-Object OwningProcess`,
        );
      } else {
        lines.push(`     lsof -iTCP:${String(port)} -sTCP:LISTEN`);
      }
    }
    return lines.join('\n');
  }

  /**
   * 显式接管：**仅在确认是 OmniHarness serve 且拿到正整数 PID 时**终止它，并等端口真正释放。
   *
   * fail-closed：分类不是 `omni`、或缺 PID、或 PID 非法 ⇒ 直接返回 false 且**不调用 kill**。
   * （判据会用一个"杀手间谍"验证这一点：任何"顺手杀掉别人进程"的实现都会当场红。）
   *
   * @param port 目标端口。
   * @param holder `probe()` 的结果。
   * @param deps 可注入依赖（kill / 等待释放）。
   * @returns 端口是否已释放（true 表示可以重试绑定）。
   */
  public static async takeOver(
    port: number,
    holder: PortHolder,
    deps: ServePortConflictDeps = {},
  ): Promise<boolean> {
    if (holder.kind !== 'omni') {
      return false;
    }
    const pid = holder.pid;
    if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
      return false;
    }
    const killer = deps.kill ?? ((target: number) => process.kill(target, 'SIGTERM'));
    try {
      killer(pid);
    } catch {
      // 已经退出 / 权限不足：都交给下面的"等端口释放"判定，不在这里谎报成功。
    }
    const wait =
      deps.waitFree ?? ((target: number) => ServePortConflict.waitUntilFree(target, deps));
    return wait(port);
  }

  /**
   * 轮询等待端口空闲（默认每 250ms 问一次，最多 6 秒）。
   * @param port 目标端口。
   * @param deps 可注入依赖（fetch / 超时）。
   * @returns 端口已空闲为 true；超时仍被占用为 false。
   */
  public static async waitUntilFree(
    port: number,
    deps: ServePortConflictDeps = {},
  ): Promise<boolean> {
    for (let i = 0; i < 24; i += 1) {
      const holder = await ServePortConflict.probe(port, deps);
      if (holder.kind === 'free') {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }
}
