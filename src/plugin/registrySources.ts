import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { get } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { join, resolve, dirname } from 'node:path';
import { manifestMatches, type PluginDescriptor, type PluginManifest } from './manifest.js';
import { type BundledPlugin } from './bundledRegistry.js';

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

/**
 * @beta
 * 已安装插件源：扫描 pluginsDir 下各子目录的 omni.plugin.json。
 */
export class LocalDirSource implements RegistrySource {
  public readonly kind = 'local' as const;

  public constructor(private readonly dir: string) {}

  public async search(query?: string): Promise<PluginDescriptor[]> {
    const out: PluginDescriptor[] = [];
    for (const entry of safeReaddir(this.dir)) {
      const manifestPath = join(this.dir, entry, 'omni.plugin.json');
      if (!existsSync(manifestPath)) {
        continue;
      }
      const manifest = readManifest(manifestPath);
      if (query !== undefined && !manifestMatches(query, manifest)) {
        continue;
      }
      out.push({
        manifest,
        installFrom: { kind: 'path', path: join(this.dir, entry) },
        source: 'local',
      });
    }
    return out;
  }

  public async get(name: string): Promise<PluginDescriptor | undefined> {
    return (await this.search()).find((d) => d.manifest.name === name);
  }
}

/**
 * @beta
 * 打包内置源：仓库自带示范插件，离线可用。
 */
export class BundledSource implements RegistrySource {
  public readonly kind = 'bundled' as const;

  /** @param plugins 打包清单 @param baseDir localPath 的解析基准（通常仓库根） */
  public constructor(
    private readonly plugins: readonly BundledPlugin[],
    private readonly baseDir: string,
  ) {}

  public async search(query?: string): Promise<PluginDescriptor[]> {
    const all = this.descriptors();
    return query === undefined ? all : all.filter((d) => manifestMatches(query, d.manifest));
  }

  public async get(name: string): Promise<PluginDescriptor | undefined> {
    return this.descriptors().find((d) => d.manifest.name === name);
  }

  /** 构造描述符：优先本地路径，其次下载地址。 */
  private descriptors(): PluginDescriptor[] {
    const out: PluginDescriptor[] = [];
    for (const plugin of this.plugins) {
      const { localPath, downloadUrl, ...manifest } = plugin;
      if (localPath !== undefined) {
        out.push({
          manifest,
          installFrom: { kind: 'path', path: resolve(this.baseDir, localPath) },
          source: 'bundled',
        });
        continue;
      }
      if (downloadUrl !== undefined) {
        out.push({ manifest, installFrom: { kind: 'url', url: downloadUrl }, source: 'bundled' });
      }
    }
    return out;
  }
}

/**
 * @beta
 * 远程 registry 源：不可达/非 JSON 时优雅降级为空，不影响本地与打包源。
 */
export class RemoteHttpSource implements RegistrySource {
  public readonly kind = 'remote' as const;

  /** @param indexUrl 索引地址 @param fetcher 可注入拉取器（测试用） */
  public constructor(
    private readonly indexUrl: string,
    private readonly fetcher: RemoteFetcher = httpsJson,
  ) {}

  public async search(query?: string): Promise<PluginDescriptor[]> {
    const all = await this.index();
    return query === undefined ? all : all.filter((d) => manifestMatches(query, d.manifest));
  }

  public async get(name: string): Promise<PluginDescriptor | undefined> {
    return (await this.index()).find((d) => d.manifest.name === name);
  }

  /** 拉取索引；任何失败都降级为空数组（离线可用是硬要求）。 */
  private async index(): Promise<PluginDescriptor[]> {
    try {
      const payload = await this.fetcher(this.indexUrl);
      const plugins = (payload as { plugins?: unknown }).plugins;
      if (!Array.isArray(plugins)) {
        return [];
      }
      const out: PluginDescriptor[] = [];
      for (const item of plugins as Array<PluginManifest & { downloadUrl?: string }>) {
        if (typeof item?.name !== 'string' || typeof item?.version !== 'string') {
          continue;
        }
        out.push({
          manifest: item,
          installFrom: { kind: 'url', url: item.downloadUrl ?? this.indexUrl },
          source: 'remote',
        });
      }
      return out;
    } catch {
      return [];
    }
  }
}

/**
 * @beta
 * 本地 catalog 占位源：读取仓库内（或任意路径）的 `registry.json`，
 * 作为离线可用的「远程 registry 占位服务」。
 *
 * 与 RemoteHttpSource 同 schema（`{ plugins: [...] }`），但数据来自文件，
 * 离线稳定、可被用户直接编辑以扩展市场，而无需改代码。
 * 这是「真实 registry 占位服务」的落地：换一个可达的 HTTP 索引即可无缝升级为远程。
 */
export class FileRegistrySource implements RegistrySource {
  public readonly kind = 'remote' as const;

  public constructor(
    private readonly catalogPath: string,
    private readonly baseDir: string = dirname(catalogPath),
  ) {}

  public async search(query?: string): Promise<PluginDescriptor[]> {
    const all = await this.catalog();
    return query === undefined ? all : all.filter((d) => manifestMatches(query, d.manifest));
  }

  public async get(name: string): Promise<PluginDescriptor | undefined> {
    return (await this.catalog()).find((d) => d.manifest.name === name);
  }

  /** 读取并解析 catalog；任何失败都降级为空数组（离线/缺文件不致命）。 */
  private async catalog(): Promise<PluginDescriptor[]> {
    try {
      if (!existsSync(this.catalogPath)) {
        return [];
      }
      const payload = JSON.parse(readFileSync(this.catalogPath, 'utf8')) as { plugins?: unknown };
      const plugins = payload.plugins;
      if (!Array.isArray(plugins)) {
        return [];
      }
      const out: PluginDescriptor[] = [];
      for (const item of plugins as Array<
        PluginManifest & { downloadUrl?: string; localPath?: string }
      >) {
        if (typeof item?.name !== 'string' || typeof item?.version !== 'string') {
          continue;
        }
        const { localPath, downloadUrl, ...manifest } = item;
        if (localPath !== undefined) {
          out.push({
            manifest,
            installFrom: { kind: 'path', path: resolve(this.baseDir, localPath) },
            source: 'remote',
          });
          continue;
        }
        out.push({
          manifest,
          installFrom: { kind: 'url', url: downloadUrl ?? this.catalogPath },
          source: 'remote',
        });
      }
      return out;
    } catch {
      return [];
    }
  }
}
