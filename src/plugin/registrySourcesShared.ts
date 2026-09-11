import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { get } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { manifestMatches, type PluginDescriptor, type PluginManifest } from './manifest.js';

/**
 * @beta
 * 拉取远程 JSON 的函数签名（可注入，便于离线测试）。
 */
export type RemoteFetcher = (url: string) => Promise<unknown>;

/**
 * @beta
 * 拉取远程字节的函数签名（可注入，便于离线测试）。
 */
export type RemoteDownloader = (url: string) => Promise<Buffer>;

/**
 * @beta
 * registry 源：提供插件发现能力。
 */
export interface RegistrySource {
  /** 源类型。 */
  readonly kind: 'local' | 'bundled' | 'remote';
  /** 按查询过滤（空查询=全量）。 */
  search(query?: string): Promise<PluginDescriptor[]>;
  /** 按唯一名取（不存在返回 undefined）。 */
  get(name: string): Promise<PluginDescriptor | undefined>;
}

/** 默认远程 registry 索引地址（占位，不可达时优雅降级为空）。
 * @beta
 * 支持 env 覆盖，便于企业内网指向私有 registry（缺省优先级低于显式 registryUrl 选项）。 */
export const DEFAULT_REGISTRY_URL =
  process.env.OMNI_REGISTRY_URL ?? 'https://registry.omniharness.dev/index.json';

/**
 * @beta
 * 用 https GET 拉取 JSON（默认 5s 超时）。
 */
export function httpsJson(url: string, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = get(url, { timeout: timeoutMs }, (response: IncomingMessage) => {
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        response.resume();
        rejectPromise(new Error(`registry 响应异常: ${status}`));
        return;
      }
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
        } catch (error) {
          rejectPromise(new Error(`registry 响应非 JSON: ${textOf(error)}`));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('registry 请求超时')));
    request.on('error', rejectPromise);
  });
}

/**
 * @beta
 * 用 https GET 下载字节。
 */
export function httpsBuffer(url: string, timeoutMs = 10_000): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = get(url, { timeout: timeoutMs }, (response: IncomingMessage) => {
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        response.resume();
        rejectPromise(new Error(`下载失败: ${url} (${status})`));
        return;
      }
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolvePromise(Buffer.concat(chunks)));
    });
    request.on('timeout', () => request.destroy(new Error(`下载超时: ${url}`)));
    request.on('error', rejectPromise);
  });
}

/** 读取并解析清单文件（源实现共享）。 */
export function readManifest(path: string): PluginManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PluginManifest;
}

/** 安全列目录（不存在返回空）。 */
export function safeReaddir(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}

/** 错误文本。 */
export function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
