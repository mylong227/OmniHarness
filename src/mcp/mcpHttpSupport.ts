/**
 * MCP Streamable HTTP 的**协议/配置辅助层**（从 `mcpHttpServer.ts` 拆出）。
 *
 * 拆出动机：`mcpHttpServer.ts` 的代码行数越过「上帝类」阈值（codeLines > 500），按本仓惯例
 * **抽出职责而不是放宽阈值**。本文件只放「无状态纯函数 + 契约类型」：
 * 配置归一化、路径/媒体类型判断、JSON-RPC 信封归一化、`Mcp-Method`/`Mcp-Name`/版本头校验、
 * CORS 头、监听错误包装与地址读取。HTTP 路由与 socket 生命周期仍留在主类。
 */
import type { IncomingMessage, Server } from 'node:http';
import type { RpcRequest } from '../ports/server/rpcRequest.ts';
import type { RpcMessage } from '../server/core/jsonRpc.ts';
import { ServerAuthGuard } from '../server/transport/serverAuthGuard.ts';
import { McpProtocol } from './mcpProtocol.ts';

/** 默认 MCP 端点路径。 */
const DEFAULT_PATH = '/mcp';
/** 默认请求体上限（1 MiB）。 */
const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;
/** 默认读取请求体超时（毫秒）。 */
const DEFAULT_READ_TIMEOUT_MS = 10_000;
/**
 * CORS 来源哨兵值（默认）：**仅回环 Origin 回显**。
 *
 * 2026-10-27 审计收口：默认 `*` 让任意网页都能跨源读取本端点响应（本端点能驱动
 * agent 工具 ⇒ 等于把本机执行面暴露给互联网内容）。改为「回环回显」后，本机开发页
 * （localhost:5173 等）照常跨源，外部页面拿不到任何跨源许可；需要开放给已知远端页面时
 * 显式配 `corsOrigin`（精确 origin 或 `'*'` 自担风险）。
 */
export const CORS_ORIGIN_LOOPBACK_ECHO = 'loopback';

/** Streamable HTTP 监听配置。 */
export interface McpHttpServerConfig {
  /** 绑定主机（默认 `127.0.0.1` 由调用方给出；本类不做隐式回落）。 */
  readonly host: string;
  /** 端口（`0` 表示由内核分配，`listen()` 回报真实端口）。 */
  readonly port: number;
  /** 端点路径（默认 `/mcp`；必须以 `/` 开头）。 */
  readonly path?: string | undefined;
  /** 请求体字节上限（默认 1 MiB）。 */
  readonly bodyLimitBytes?: number | undefined;
  /** 读取请求体超时毫秒（默认 10 s）。 */
  readonly readTimeoutMs?: number | undefined;
  /** CORS `Access-Control-Allow-Origin`（默认仅回环回显，见 {@link CORS_ORIGIN_LOOPBACK_ECHO}）。 */
  readonly corsOrigin?: string | undefined;
  /**
   * Bearer 令牌（2026-10-27 审计收口）：非空时**所有**请求都要求
   * `Authorization: Bearer <token>`（或 `?token=`）；非回环绑定必须配令牌。
   * 缺省由构造方回落 `OMNI_SERVE_TOKEN` 环境变量。
   */
  readonly token?: string | undefined;
}

/** `listen()` 回报的实际监听地址（端口 0 时是内核分配的真实端口）。 */
export interface McpHttpListenAddress {
  /** 实际绑定主机。 */
  readonly host: string;
  /** 实际绑定端口（非 0）。 */
  readonly port: number;
}

/** 归一化后的配置（构造期校验一次，运行时不再重复判断）。 */
export interface NormalizedHttpConfig {
  /** 绑定主机。 */
  readonly host: string;
  /** 绑定端口。 */
  readonly port: number;
  /** 去尾斜杠后的端点路径。 */
  readonly path: string;
  /** 请求体字节上限。 */
  readonly bodyLimitBytes: number;
  /** 读取请求体超时毫秒。 */
  readonly readTimeoutMs: number;
  /** CORS 允许来源（`loopback` 哨兵 = 仅回环回显）。 */
  readonly corsOrigin: string;
  /** Bearer 令牌（空串 = 未启用鉴权）。 */
  readonly token: string;
}

/** 头校验失败（HTTP 层直接回 400，不进入服务端分发）。 */
export interface HeaderFailure {
  /** JSON-RPC 错误码。 */
  readonly code: number;
  /** 可读原因。 */
  readonly message: string;
  /** 结构化附加信息。 */
  readonly data?: unknown;
}

/**
 * 取单个请求头文本（多值取第一个；缺失/空串返回 undefined）。
 * @param request 入站请求。
 * @param name 小写头名。
 * @returns 去空白后的头值。
 */
export const headerText = (request: IncomingMessage, name: string): string | undefined => {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/**
 * 是否普通对象（排除 null/数组）。
 * @param value 待判值。
 * @returns 普通对象为 true。
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 归一化并校验配置（fail-fast：非法 host/port/path 在构造期即抛错）。
 * @param config 原始配置。
 * @returns 归一化配置。
 * @throws Error host/port/path/上限非法时抛出。
 */
export const normalizeHttpConfig = (config: McpHttpServerConfig): NormalizedHttpConfig => {
  if (config.host.trim() === '') throw new Error('McpHttpServer 需要非空 host');
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error(`McpHttpServer 端口必须是 0..65535 的整数（当前 ${String(config.port)}）`);
  }
  const path = config.path ?? DEFAULT_PATH;
  if (!path.startsWith('/')) throw new Error(`McpHttpServer 路径必须以 / 开头（当前 ${path}）`);
  const bodyLimitBytes = config.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;
  if (!Number.isInteger(bodyLimitBytes) || bodyLimitBytes < 1) {
    throw new Error('McpHttpServer bodyLimitBytes 必须是正整数');
  }
  const readTimeoutMs = config.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  if (!Number.isInteger(readTimeoutMs) || readTimeoutMs < 1) {
    throw new Error('McpHttpServer readTimeoutMs 必须是正整数');
  }
  const corsOrigin = config.corsOrigin ?? CORS_ORIGIN_LOOPBACK_ECHO;
  if (corsOrigin.trim() === '') throw new Error('McpHttpServer corsOrigin 不能为空');
  return {
    host: config.host,
    port: config.port,
    path: path.length > 1 ? path.replace(/\/+$/u, '') : path,
    bodyLimitBytes,
    readTimeoutMs,
    corsOrigin,
    token: (config.token ?? '').trim(),
  };
};

/**
 * 路径匹配（精确匹配，容忍一个尾斜杠）。
 * @param pathname 请求路径。
 * @param configured 配置路径。
 * @returns 命中为 true。
 */
export const matchesHttpPath = (pathname: string, configured: string): boolean => {
  if (configured === '/') return pathname === '/';
  return pathname === configured || pathname === `${configured}/`;
};

/**
 * `Content-Type` 是否 `application/json`（允许 charset 等参数）。
 * @param value 头值。
 * @returns 是 JSON 为 true。
 */
export const isJsonContentType = (value: string | undefined): boolean => {
  if (value === undefined) return false;
  return (value.split(';')[0] ?? '').trim().toLowerCase() === 'application/json';
};

/**
 * `Accept` 是否允许指定媒体类型（支持 `* / *`；JSON 额外接受 `application/*`）。
 * @param header `Accept` 头（缺省视为接受）。
 * @param mediaType 目标媒体类型。
 * @returns 允许为 true。
 */
export const acceptsMediaType = (header: string | undefined, mediaType: string): boolean => {
  if (header === undefined) return true;
  return header.split(',').some((part) => {
    const media = (part.split(';')[0] ?? '').trim().toLowerCase();
    if (media === '*/*' || media === mediaType) return true;
    return mediaType === 'application/json' && media === 'application/*';
  });
};

/**
 * 从请求 `_meta` 取协议版本（仅接受非空字符串）。
 * @param message 入站消息。
 * @returns 版本；缺省/形状非法为 undefined。
 */
export const metaVersionOf = (message: RpcMessage): string | undefined => {
  if (!('method' in message)) return undefined;
  const params = message.params;
  if (!isRecord(params)) return undefined;
  const meta = params['_meta'];
  if (!isRecord(meta)) return undefined;
  const version = meta[McpProtocol.META_PROTOCOL_VERSION];
  return typeof version === 'string' && version !== '' ? version : undefined;
};

/**
 * 归一化单条入站消息（必须是 JSON-RPC 请求或通知）。
 * @param value 已解析的 JSON 值。
 * @returns 规范化消息；形状非法为 undefined。
 */
const normalizeMessage = (value: unknown): RpcMessage | undefined => {
  if (!isRecord(value)) return undefined;
  if (value['jsonrpc'] !== '2.0') return undefined;
  const method = value['method'];
  if (typeof method !== 'string' || method === '') return undefined;
  const rawParams = value['params'];
  if (rawParams !== undefined && rawParams !== null && !isRecord(rawParams)) return undefined;
  const params = isRecord(rawParams) ? rawParams : undefined;
  const id = value['id'];
  if (id === undefined) {
    return params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params };
  }
  if (typeof id !== 'number' && typeof id !== 'string') return undefined;
  return params === undefined
    ? { jsonrpc: '2.0', id, method }
    : { jsonrpc: '2.0', id, method, params };
};

/**
 * 归一化请求体（单条对象或非空批量数组）。
 * @param parsed 已解析的 JSON 值。
 * @returns 消息列表；非法为 undefined。
 */
export const normalizeHttpMessages = (parsed: unknown): readonly RpcMessage[] | undefined => {
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return undefined;
    const messages: RpcMessage[] = [];
    for (const item of parsed) {
      const message = normalizeMessage(item);
      if (message === undefined) return undefined;
      messages.push(message);
    }
    return messages;
  }
  const single = normalizeMessage(parsed);
  return single === undefined ? undefined : [single];
};

/**
 * 校验 HTTP 头与请求体的一致性（2026-07-28 的 `Mcp-Method` / `Mcp-Name` / 版本头）。
 *
 * 批量请求无法用单个 `Mcp-Method` 表达多方法：此时头可缺省，但**出现即必须全部一致**。
 * @param request 入站请求。
 * @param messages 归一化消息。
 * @param batch 是否批量请求。
 * @returns 失败描述；一致时为 undefined。
 */
export const headerMismatchOf = (
  request: IncomingMessage,
  messages: readonly RpcMessage[],
  batch: boolean,
): HeaderFailure | undefined => {
  const versionHeader = headerText(request, 'mcp-protocol-version');
  const methodHeader = headerText(request, 'mcp-method');
  const nameHeader = headerText(request, 'mcp-name');
  const versions = new Set<string>();
  for (const message of messages) {
    const version = metaVersionOf(message);
    if (version !== undefined) versions.add(version);
  }
  if (versions.size > 0) {
    if (versionHeader === undefined) {
      return {
        code: McpProtocol.ERROR_HEADER_MISMATCH,
        message: '现代（2026-07-28）请求必须携带 MCP-Protocol-Version 头',
      };
    }
    for (const version of versions) {
      if (version !== versionHeader) {
        return {
          code: McpProtocol.ERROR_HEADER_MISMATCH,
          message: `MCP-Protocol-Version 头与请求 _meta 不一致：头=${versionHeader}，_meta=${version}`,
        };
      }
    }
  } else if (
    versionHeader !== undefined &&
    !McpProtocol.SUPPORTED_VERSIONS.includes(versionHeader)
  ) {
    return {
      code: McpProtocol.ERROR_UNSUPPORTED_PROTOCOL_VERSION,
      message: `不支持的 MCP-Protocol-Version 头：${versionHeader}`,
      data: { supported: [...McpProtocol.SUPPORTED_VERSIONS], requested: versionHeader },
    };
  }
  for (const message of messages) {
    if (!('method' in message)) continue;
    const modern = metaVersionOf(message) !== undefined;
    if (methodHeader !== undefined && methodHeader !== message.method) {
      return {
        code: McpProtocol.ERROR_HEADER_MISMATCH,
        message: `Mcp-Method 头与请求 method 不一致：头=${methodHeader}，method=${message.method}`,
      };
    }
    if (modern && !batch && methodHeader === undefined) {
      return {
        code: McpProtocol.ERROR_HEADER_MISMATCH,
        message: `现代请求必须携带 Mcp-Method 头（method=${message.method}）`,
      };
    }
    if (message.method !== McpProtocol.METHOD_TOOLS_CALL) {
      if (nameHeader !== undefined) {
        return {
          code: McpProtocol.ERROR_HEADER_MISMATCH,
          message: `Mcp-Name 头只能用于 tools/call（method=${message.method}）`,
        };
      }
      continue;
    }
    const params = message.params;
    const name = isRecord(params) ? params['name'] : undefined;
    if (nameHeader !== undefined && nameHeader !== name) {
      return {
        code: McpProtocol.ERROR_HEADER_MISMATCH,
        message: `Mcp-Name 头与 tools/call 的 name 不一致：头=${nameHeader}，name=${String(name)}`,
      };
    }
    if (modern && !batch && nameHeader === undefined) {
      return {
        code: McpProtocol.ERROR_HEADER_MISMATCH,
        message: '现代 tools/call 请求必须携带 Mcp-Name 头',
      };
    }
  }
  return undefined;
};

/**
 * 把响应消息映射为 HTTP 状态码（头/版本类错误按传输层语义回 400，其余 JSON-RPC 错误仍 200）。
 * @param message 单条响应。
 * @returns HTTP 状态码。
 */
export const statusOfRpcMessage = (message: RpcMessage): number => {
  if ('method' in message) return 200;
  const error = message.error;
  if (error === undefined) return 200;
  return error.code === McpProtocol.ERROR_HEADER_MISMATCH ||
    error.code === McpProtocol.ERROR_UNSUPPORTED_PROTOCOL_VERSION
    ? 400
    : 200;
};

/**
 * CORS 响应头（预检与普通响应共用；`Vary: Origin` 恒写，其余头按来源策略）。
 * @param origin 配置的来源策略（`loopback` 哨兵 / `*` / 精确 origin）。
 * @param requestOrigin 请求的 Origin 头（无/非法 = 非浏览器客户端）。
 * @returns 头名 → 头值（无跨源许可时只含 Vary）。
 */
const corsHeadersFor = (
  origin: string,
  requestOrigin: string | undefined,
): Readonly<Record<string, string>> => {
  const headers: Record<string, string> = { Vary: 'Origin' };
  let allowed: string | undefined;
  if (origin === '*') {
    allowed = '*';
  } else if (origin === CORS_ORIGIN_LOOPBACK_ECHO) {
    if (requestOrigin !== undefined && ServerAuthGuard.isLoopback(HostOf(requestOrigin))) {
      allowed = requestOrigin;
    }
  } else if (requestOrigin !== undefined && requestOrigin === origin) {
    allowed = requestOrigin;
  }
  if (allowed === undefined) return headers;
  return {
    ...headers,
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Mcp-Task',
    'Access-Control-Expose-Headers': 'MCP-Protocol-Version, Mcp-Session-Id',
    'Access-Control-Max-Age': '86400',
  };
};

/** 取 Origin 的主机名（非法 URL 返回原文，交给回环判断兜底为 false）。 */
const HostOf = (origin: string): string => {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
};

/**
 * 把 CORS 头写入响应（`loopback` 哨兵策略按请求 Origin 决定是否回显）。
 * @param response 响应对象（只要求 `setHeader`）。
 * @param origin 配置的来源策略。
 * @param requestOrigin 请求的 Origin 头。
 * @returns 无返回值。
 */
export const applyCorsHeaders = (
  response: { setHeader(name: string, value: string): void },
  origin: string,
  requestOrigin: string | undefined,
): void => {
  for (const [name, value] of Object.entries(corsHeadersFor(origin, requestOrigin))) {
    response.setHeader(name, value);
  }
};

/**
 * 把监听错误包装成可行动消息（端口占用 / 权限 / 地址不可用各给一条处置建议）。
 * @param config 归一化配置。
 * @param error 原始错误。
 * @returns 带建议的错误。
 */
export const listenFailureOf = (config: NormalizedHttpConfig, error: unknown): Error => {
  const cause = error instanceof Error ? error : new Error(String(error));
  const code = (cause as NodeJS.ErrnoException).code;
  let hint = '检查 host/port 与防火墙设置';
  if (code === 'EADDRINUSE') {
    hint = `端口 ${config.port} 已被占用：换一个 --mcp-http-port，或先释放该端口`;
  } else if (code === 'EACCES') {
    hint = '端口权限不足：改用 1024 以上端口，或以具备绑定权限的账户运行';
  } else if (code === 'EADDRNOTAVAIL' || code === 'ENOTFOUND') {
    hint = `主机地址不可用：检查 --mcp-http-host（当前 ${config.host}）`;
  }
  return new Error(
    `MCP Streamable HTTP 监听失败（${config.host}:${config.port}）：${cause.message}。${hint}`,
  );
};

/**
 * 读取 node:http 实际监听地址（端口 0 时取内核分配的真实端口）。
 * @param server HTTP 服务器。
 * @param host 配置的绑定主机。
 * @returns 监听地址。
 * @throws 地址为 pipe/未监听时抛出。
 */
export const listenAddressOf = (server: Server, host: string): McpHttpListenAddress => {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('MCP HTTP 服务器未监听 TCP 端口（address 为空或为 pipe 路径）');
  }
  return { host, port: address.port };
};

/**
 * 判断是否为 `subscriptions/listen` 请求（带 id）。
 * @param message 入站消息。
 * @returns 是 listen 请求为 true。
 */
export const isListenRequest = (message: RpcMessage): message is RpcRequest =>
  'method' in message &&
  'id' in message &&
  message.method === McpProtocol.METHOD_SUBSCRIPTIONS_LISTEN;
