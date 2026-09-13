import { existsSync, mkdirSync, writeFileSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateManifestPermissions,
  type PluginDescriptor,
  type PluginManifest,
} from './manifest.js';
import { BUNDLED_PLUGINS, type BundledPlugin } from './bundledRegistry.js';
import {
  DEFAULT_REGISTRY_URL,
  httpsBuffer,
  type RegistrySource,
  type RemoteDownloader,
  LocalDirSource,
  BundledSource,
  FileRegistrySource,
  RemoteHttpSource,
} from './registrySources.js';

export * from './registrySources.js';

/**
 * @beta
 * PluginRegistry 选项。
 */
export interface PluginRegistryOptions {
  /** 已安装插件目录。 */
  readonly pluginsDir: string;
  /** 自定义源（缺省=本地+打包+远程）。 */
  readonly sources?: readonly RegistrySource[];
  /** 远程索引地址。 */
  readonly registryUrl?: string;
  /** 本地 catalog 占位文件路径（真实 registry 占位服务，离线可用）。 */
  readonly registryFile?: string;
  /** catalog 内 localPath 的解析基准（缺省=catalog 所在目录）。 */
  readonly registryBaseDir?: string;
  /** 打包清单（缺省用 BUNDLED_PLUGINS）。 */
  readonly bundledPlugins?: readonly BundledPlugin[];
  /** 打包插件的基准目录（localPath 解析用）。 */
  readonly bundledBaseDir?: string;
  /** 远程下载器（测试可注入）。 */
  readonly downloader?: RemoteDownloader;
}

/**
 * @beta
 * 插件注册表：发现 / 安装 / 移除。
 *
 * 设计要点（对齐 P2）：
 * - 源优先级 local > bundled > remote，同名去重取先到者，本地已安装优先展示。
 * - 安装前校验清单权限全部合法，非法即抛错（fail-closed），绝不静默降级。
 * - 远程不可达时优雅降级为空，保证离线环境 CLI 完全可用。
 */
export class PluginRegistry {
  private readonly sources: readonly RegistrySource[];

  public constructor(public readonly options: PluginRegistryOptions) {
    // registryUrl 缺省时落回「env 覆盖后的默认值」：env > DEFAULT_REGISTRY_URL。
    // 固化回 options，便于调用方与测试核对解析结果（接口字段为 readonly，此处做一次规范化赋值）。
    const resolvedRegistryUrl =
      options.registryUrl ?? process.env.OMNI_REGISTRY_URL ?? DEFAULT_REGISTRY_URL;
    (options as { registryUrl: string }).registryUrl = resolvedRegistryUrl;

    this.sources = options.sources ?? [
      new LocalDirSource(options.pluginsDir),
      new BundledSource(
        options.bundledPlugins ?? BUNDLED_PLUGINS,
        options.bundledBaseDir ?? process.cwd(),
      ),
      ...(options.registryFile !== undefined
        ? [new FileRegistrySource(options.registryFile, options.registryBaseDir)]
        : []),
      new RemoteHttpSource(options.registryUrl ?? DEFAULT_REGISTRY_URL),
    ];
  }

  /** 跨源搜索（去重，源顺序即优先级）。 */
  public async search(query?: string): Promise<PluginDescriptor[]> {
    const batches = await Promise.all(this.sources.map((source) => source.search(query)));
    const seen = new Set<string>();
    const out: PluginDescriptor[] = [];
    for (const batch of batches) {
      for (const descriptor of batch) {
        if (seen.has(descriptor.manifest.name)) {
          continue;
        }
        seen.add(descriptor.manifest.name);
        out.push(descriptor);
      }
    }
    return out;
  }

  /** 已安装插件清单（仅本地目录）。 */
  public async list(): Promise<PluginManifest[]> {
    if (!existsSync(this.options.pluginsDir)) {
      return [];
    }
    return new LocalDirSource(this.options.pluginsDir)
      .search()
      .then((descriptors) => descriptors.map((d) => d.manifest));
  }

  /** 按名取首个匹配（源顺序即优先级）。 */
  public async get(name: string): Promise<PluginDescriptor | undefined> {
    for (const source of this.sources) {
      const descriptor = await source.get(name);
      if (descriptor !== undefined) {
        return descriptor;
      }
    }
    return undefined;
  }

  /**
   * 安装插件：复制（本地/打包）或下载（远程）到 pluginsDir/<name>，
   * 并落盘权威清单 omni.plugin.json。权限非法直接抛错，不落盘半成品。
   */
  public async install(name: string): Promise<PluginManifest> {
    const descriptor = await this.get(name);
    if (descriptor === undefined) {
      throw new Error(`未找到插件: ${name}（用 plugin search 查看可用项）`);
    }
    // 先校验权限，非法即中止（fail-closed），避免落盘半成品。
    validateManifestPermissions(descriptor.manifest);

    const target = join(this.options.pluginsDir, descriptor.manifest.name);
    if (descriptor.installFrom.kind === 'path') {
      const source = descriptor.installFrom.path;
      if (!existsSync(source)) {
        throw new Error(`插件源目录不存在: ${source}`);
      }
      copyDirRecursive(source, target);
    } else {
      const buffer = await (this.options.downloader ?? httpsBuffer)(descriptor.installFrom.url);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, descriptor.manifest.entry ?? 'index.js'), buffer);
    }
    writeFileSync(
      join(target, 'omni.plugin.json'),
      JSON.stringify(descriptor.manifest, null, 2),
      'utf8',
    );
    this.ensureEsmMarker(target);
    return descriptor.manifest;
  }

  /**
   * 确保插件目录按 ESM 解析。
   *
   * 安装目录通常没有 package.json，Node 会按 CommonJS 解析 .js，
   * 导致 `export default` 语法报错；补一个 {"type":"module"} 标记即可。
   * 源目录若自带 package.json 则原样保留，不覆盖其配置。
   
 * @returns 无返回值。
*/
  private ensureEsmMarker(dir: string): void {
    const markerPath = join(dir, 'package.json');
    if (existsSync(markerPath)) {
      return;
    }
    writeFileSync(markerPath, `${JSON.stringify({ type: 'module' }, null, 2)}\n`, 'utf8');
  }

  /** 移除已安装插件。isLoaded 返回 true 时拒绝移除，避免破坏运行中的实例。
   * @returns 无返回值。
   */
  public async remove(name: string, isLoaded?: (name: string) => boolean): Promise<void> {
    if (isLoaded?.(name) === true) {
      throw new Error(`插件 "${name}" 当前已加载，请先卸载再移除`);
    }
    const target = join(this.options.pluginsDir, name);
    if (!existsSync(target)) {
      throw new Error(`未安装插件: ${name}`);
    }
    rmSync(target, { recursive: true, force: true });
  }
}

/**
 * 递归复制目录。
 *
 * 不用 node:fs 的 cpSync：它在 Windows 上走 `\\?\` 扩展长度前缀，
 * 遇到含非 ASCII 字符的临时目录会抛 EIO "Access is denied"（本机实测），
 * 且与是否预建目标目录无关。此处以 readdir + copyFileSync 自行递归。
 * copyFileSync 对符号链接取内容复制，插件分发场景等价于普通文件。
 */
function copyDirRecursive(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(sourcePath, targetPath);
    } else {
      copyFileSync(sourcePath, targetPath);
    }
  }
}
