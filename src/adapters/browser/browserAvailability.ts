/**
 * 浏览器截图**能力探测**：注册/调用 `browser_screenshot` 之前，先如实回答「这台机器到底能不能截图」。
 *
 * ## 为什么需要单独一层
 *
 * 截图能力依赖两件外部事实：本机装了 Chromium 系浏览器，或已经有一个可连的 CDP 端点。
 * 二者都不在代码里，**探测不到就必须给可执行的原因**，而不是等模型调用时抛一句
 * 「网页截图失败: ...」——那会让模型反复重试一个必然失败的工具（本仓在 LSP 工具上
 * 已经踩过同一个坑，见 `configToolRegistry` 里「不暴露必然失败的死工具」的注释）。
 *
 * 三类失败必须分得开，因为补救动作完全不同：
 * - `chrome-missing`：没有浏览器 ⇒ 装浏览器或给 `CHROME_PATH`；
 * - `cdp-unreachable`：外部端点连不上 ⇒ 检查端点/删除 `OMNI_CDP_ENDPOINT` 走自启；
 * - `cdp-timeout`：端点探不通 ⇒ 查防火墙/走自启。
 *
 * 探测输入全部可注入（定位函数、端点自检函数、环境变量表），故单测**不需要真浏览器、
 * 也不需要真 CDP 端点**；探测本身**不 spawn 任何进程**。
 */
import { ChromeLocator } from './chromeLocator.js';
import type { ChromeLocatorOptions, ChromeLookup } from './chromeLocator.js';
import { endpointDefaults } from '../../util/endpointDefaults.js';

/** 浏览器截图不可用的类别（决定给模型的可执行建议）。 */
export type BrowserUnavailableKind =
  'chrome-missing' | 'cdp-unreachable' | 'cdp-timeout' | 'unknown';

/** 探测结果。 */
export interface BrowserAvailabilityReport {
  /** 是否具备截图能力（有浏览器，或有一个可连的 CDP 端点）。 */
  readonly available: boolean;
  /** 命中的浏览器可执行文件绝对路径（未命中为 null）。 */
  readonly executable: string | null;
  /** 使用的外部 CDP 端点（未配置为 null）。 */
  readonly endpoint: string | null;
  /** 不可用时的类别；可用时为 null。 */
  readonly kind: BrowserUnavailableKind | null;
  /** 人话原因（不可用时即**可执行**的补救说明）。 */
  readonly reason: string;
  /** 依序尝试过的浏览器候选路径（排错用）。 */
  readonly searched: readonly string[];
}

/** 探测输入（全部可注入，便于测试脱离本机环境）。 */
export interface BrowserAvailabilityInput {
  /** 浏览器定位选项（透传给 {@link ChromeLocator.locate}）。 */
  readonly locator?: ChromeLocatorOptions | undefined;
  /** 浏览器定位函数（默认 {@link ChromeLocator.locate}）。 */
  readonly locate?: ((options: ChromeLocatorOptions) => ChromeLookup) | undefined;
  /** 环境变量表（默认 `process.env`；读 `OMNI_CDP_ENDPOINT`）。 */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** 显式外部 CDP 端点（优先于环境变量）。 */
  readonly endpoint?: string | undefined;
  /** 端点自检函数（默认 fetch `/json/version`；resolve=可用，reject=不可用）。 */
  readonly probeEndpoint?: ((endpoint: string) => Promise<void>) | undefined;
  /** 端点自检超时毫秒数（默认 5s）。 */
  readonly timeoutMs?: number | undefined;
}

/**
 * 浏览器截图能力探测器（无状态，纯静态）。
 */
export class BrowserAvailability {
  /** 外部 CDP 端点环境变量名（设置了就优先用它，不再自启浏览器）。 */
  public static readonly ENDPOINT_ENV = 'OMNI_CDP_ENDPOINT';

  /** 端点自检默认超时（毫秒）。 */
  public static readonly DEFAULT_PROBE_TIMEOUT_MS = 5_000;

  private constructor() {}

  /**
   * 探测本机是否具备网页截图能力。
   *
   * @param input 探测输入（可注入）。
   * @returns 可用性报告（不可用时含类别与可执行原因）。
   */
  public static async probe(
    input: BrowserAvailabilityInput = {},
  ): Promise<BrowserAvailabilityReport> {
    const env = input.env ?? process.env;
    const endpoint = BrowserAvailability.endpointOf(input, env);
    const locate = input.locate ?? ChromeLocator.locate;
    const lookup = locate(input.locator ?? {});
    if (endpoint !== null) {
      return await BrowserAvailability.probeEndpoint(endpoint, lookup, input);
    }
    if (lookup.executable !== null) {
      return {
        available: true,
        executable: lookup.executable,
        endpoint: null,
        kind: null,
        reason: `找到浏览器可执行文件（${lookup.executable}）：将以 headless 方式自启并截图。`,
        searched: lookup.searched,
      };
    }
    return {
      available: false,
      executable: null,
      endpoint: null,
      kind: 'chrome-missing',
      reason: `${BrowserAvailability.advice('chrome-missing')}已查找：${BrowserAvailability.summarize(lookup.searched)}`,
      searched: lookup.searched,
    };
  }

  /**
   * 把异常归类为可执行建议所需的类别。
   *
   * @param error 抛出的任意值（通常是 BrowserSession 的错误）。
   * @returns 不可用类别（无法判定时为 `unknown`）。
   */
  public static classifyError(error: unknown): BrowserUnavailableKind {
    const detail = BrowserAvailability.detailOf(error);
    const name = error instanceof Error ? error.name : '';
    if (/未找到 Chrome\/Edge|CHROME_PATH|OMNI_CHROME_PATH/.test(detail)) {
      return 'chrome-missing';
    }
    if (name === 'AbortError' || /超时|未在[^。]*内|timed?\s?out/i.test(detail)) {
      return 'cdp-timeout';
    }
    if (/CDP|DevTools|WebSocket|ECONNREFUSED|端口/.test(detail)) {
      return 'cdp-unreachable';
    }
    return 'unknown';
  }

  /**
   * 把类别翻译成**可执行**的建议（不是「失败了」这种无信息量的话）。
   *
   * @param kind 不可用类别。
   * @returns 可执行建议文本。
   */
  public static advice(kind: BrowserUnavailableKind): string {
    switch (kind) {
      case 'chrome-missing':
        return (
          '未找到 Chrome/Edge 可执行文件。可执行：1) 安装 Google Chrome 或 Microsoft Edge；' +
          '2) 或设置 CHROME_PATH（本仓优先 OMNI_CHROME_PATH）指向浏览器可执行文件的绝对路径后重启会话。'
        );
      case 'cdp-unreachable':
        return (
          '外部 CDP 端点不可达。可执行：1) 确认该浏览器仍在运行且端口正确' +
          `（自检：请求 <端点>${endpointDefaults.urlOf('cdpVersionPath')}）；` +
          `2) 或删除环境变量 ${BrowserAvailability.ENDPOINT_ENV}，让本工具自行启动 headless Chrome/Edge。`
        );
      case 'cdp-timeout':
        return (
          'CDP 端点探测超时。可执行：1) 检查该端口是否被防火墙/代理拦截；' +
          `2) 或删除环境变量 ${BrowserAvailability.ENDPOINT_ENV} 走自启路径；` +
          '3) 或调大探测超时（BrowserAvailabilityInput.timeoutMs）。'
        );
      default:
        return '未知失败。可执行：查看下方原始错误文本；若持续出现请把该文本附到问题单里。';
    }
  }

  /**
   * 把外部 CDP 端点规范成 `/json/version` 自检地址（`ws://` 端点自动换算出 http 地址）。
   *
   * @param endpoint 端点（`http://host:port` / `ws://host:port/devtools/...`）。
   * @returns 自检 URL。
   */
  public static versionUrl(endpoint: string): string {
    // 自检路径取自 `defaults/endpoints.json`（用户指令：地址不硬编码）；常规值为 `/json/version`。
    const path = endpointDefaults.urlOf('cdpVersionPath');
    const trimmed = endpoint.trim().replace(/\/+$/, '');
    if (trimmed.startsWith('ws://')) {
      return `http://${BrowserAvailability.hostOf(trimmed.slice('ws://'.length))}${path}`;
    }
    if (trimmed.startsWith('wss://')) {
      return `https://${BrowserAvailability.hostOf(trimmed.slice('wss://'.length))}${path}`;
    }
    return `${trimmed}${path}`;
  }

  /**
   * 解析端点来源：显式入参优先，其次环境变量（空串视为未设置）。
   *
   * @param input 探测输入。
   * @param env 环境变量表。
   * @returns 端点文本；未配置时为 null。
   */
  private static endpointOf(
    input: BrowserAvailabilityInput,
    env: Readonly<Record<string, string | undefined>>,
  ): string | null {
    const raw = input.endpoint ?? env[BrowserAvailability.ENDPOINT_ENV] ?? '';
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
  }

  /**
   * 探测外部端点：成功即「可用」，失败按类别给可执行原因（绝不抛）。
   *
   * @param endpoint 端点。
   * @param lookup 浏览器定位结果（端点可用时仅作附加信息）。
   * @param input 探测输入（提供自检函数与超时）。
   * @returns 可用性报告。
   */
  private static async probeEndpoint(
    endpoint: string,
    lookup: ChromeLookup,
    input: BrowserAvailabilityInput,
  ): Promise<BrowserAvailabilityReport> {
    const timeoutMs = input.timeoutMs ?? BrowserAvailability.DEFAULT_PROBE_TIMEOUT_MS;
    const probe =
      input.probeEndpoint ?? ((url: string) => BrowserAvailability.defaultProbe(url, timeoutMs));
    try {
      await probe(endpoint);
      return {
        available: true,
        executable: lookup.executable,
        endpoint,
        kind: null,
        reason: `外部 CDP 端点可用（${endpoint}）：将附着到该浏览器截图。`,
        searched: lookup.searched,
      };
    } catch (error) {
      const detected = BrowserAvailability.classifyError(error);
      const kind: BrowserUnavailableKind = detected === 'unknown' ? 'cdp-unreachable' : detected;
      return {
        available: false,
        executable: lookup.executable,
        endpoint,
        kind,
        reason: `${BrowserAvailability.advice(kind)}（端点自检失败：${BrowserAvailability.detailOf(error)}）`,
        searched: lookup.searched,
      };
    }
  }

  /**
   * 默认端点自检：请求 `/json/version`，超时即中止。
   *
   * @param endpoint 端点。
   * @param timeoutMs 超时毫秒数。
   * @returns 自检通过时 resolve；否则 reject（`AbortError` = 超时）。
   */
  private static async defaultProbe(endpoint: string, timeoutMs: number): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(BrowserAvailability.versionUrl(endpoint), {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`CDP 端点自检返回 HTTP ${String(response.status)}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 从 `host:port/path` 形态里取回 `host:port`。
   *
   * @param rest 去协议前缀后的剩余部分。
   * @returns `host:port`。
   */
  private static hostOf(rest: string): string {
    const slash = rest.indexOf('/');
    return slash < 0 ? rest : rest.slice(0, slash);
  }

  /**
   * 提取错误消息文本。
   *
   * @param error 任意抛出值。
   * @returns Error 取 message，其余 String()。
   */
  private static detailOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * 把候选清单压成一行（截断到 8 项，避免把整份 PATH 扫描结果灌进错误文案）。
   *
   * @param searched 候选路径。
   * @returns 单行文本。
   */
  private static summarize(searched: readonly string[]): string {
    const head = searched.slice(0, 8).join(' / ');
    return searched.length > 8 ? `${head} …` : head === '' ? '(无候选)' : head;
  }
}
