import { createHmac, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
  copyFileSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { zipStore, unzip, type ZipEntry } from './zip.js';
import type { PluginProfile } from './pluginProfileStore.js';
import type { PluginRegistry } from './pluginRegistry.js';

/**
 * Bundle 发布单元（G-E 5.2/5.3，对标 dsh 可 patch 插件叠层 + 发布单元）。
 *
 * 一个 bundle = 命名插件集 + 补丁层（config 覆盖）+ 可选 HMAC 签名，打包为自包含 `.ohb`
 * （store 方法 zip）。`packBundle` 把 profile 的插件目录与清单封进 zip；`unpackBundle`
 * 还原插件到 pluginsDir 并写入补丁层，供运行时配置合并。
 */

/**
 * @beta
 * 插件引用（打包时记录来源，解包时据此还原/回源）。
 */
export interface BundlePluginRef {
  readonly name: string;
  readonly from: 'bundled' | 'path';
  readonly localPath?: string;
}

/**
 * @beta
 * 补丁层条目：对运行时 config 的 key 级覆盖。
 */
export interface BundlePatch {
  readonly key: string;
  readonly value: unknown;
}

/**
 * @beta
 * Bundle 清单。
 */
export interface BundleManifest {
  readonly name: string;
  readonly version: string;
  readonly plugins: readonly BundlePluginRef[];
  readonly patches: readonly BundlePatch[];
  readonly signature?: string;
}

/**
 * @beta
 * 打包参数。
 */
export interface PackBundleOptions {
  readonly workspaceDir: string;
  readonly profile: PluginProfile;
  readonly registry: PluginRegistry;
  readonly pluginsDir: string;
  /** HMAC 签名密钥文件路径（提供则对清单签名；缺省不签名）。 */
  readonly keyFile?: string;
  /** 输出目录（缺省 <workspaceDir>/.omniharness/bundles）。 */
  readonly outDir?: string;
}

/**
 * @beta
 * 打包结果。
 */
export interface PackBundleResult {
  readonly path: string;
  readonly manifest: BundleManifest;
}

/**
 * @beta
 * 解包参数。
 */
export interface UnpackBundleOptions {
  readonly zipPath: string;
  readonly pluginsDir: string;
  readonly workspaceDir: string;
  readonly keyFile?: string;
}

/**
 * @beta
 * 解包结果。
 */
export interface UnpackBundleResult {
  readonly manifest: BundleManifest;
  readonly installed: string[];
  readonly patchFile: string;
}

/**
 * 插件打包器：原模块级纯函数归拢为 `PluginBundler` 静态方法族，现改为实例方法以消除 `static`
 * （无隐式状态，同一实例可并发复用）。对外门面函数（`packBundle` / `unpackBundle`）签名不变，
 * 调用点（CLI bundle 子命令）零改动。
 */
export class PluginBundler {
  /** 规范化的清单字符串（排除 signature，供签名/校验）。 */
  private canonicalManifest(manifest: BundleManifest): string {
    const { signature: _omit, ...rest } = manifest;
    const keys = Object.keys(rest).sort();
    return JSON.stringify(rest, keys);
  }

  /** 用密钥对清单做 HMAC-SHA256。 */
  private signManifest(manifest: BundleManifest, key: Buffer): string {
    return createHmac('sha256', key).update(this.canonicalManifest(manifest)).digest('hex');
  }

  /** 读取或生成 HMAC 密钥（首次生成以 0600 落盘）。 */
  private resolveKey(keyFile: string): Buffer {
    if (existsSync(keyFile)) {
      return Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'hex');
    }
    const key = randomBytes(32);
    writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
    try {
      chmodSync(keyFile, 0o600);
    } catch {
      /* 权限设置失败不致命 */
    }
    return key;
  }

  /** 递归收集目录内所有文件为 zip 条目（name 相对 base）。 */
  private collectEntries(dir: string, base: string, out: ZipEntry[]): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = base === '' ? entry.name : `${base}/${entry.name}`;
      if (entry.isDirectory()) {
        this.collectEntries(full, rel, out);
      } else {
        out.push({ name: rel, data: readFileSync(full) });
      }
    }
  }

  /** 递归复制目录（同 registry.copyDirRecursive 思路，避开 Windows \\?\ 坑）。 */
  private copyDir(source: string, target: string): void {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const s = join(source, entry.name);
      const t = join(target, entry.name);
      if (entry.isDirectory()) {
        this.copyDir(s, t);
      } else {
        copyFileSync(s, t);
      }
    }
  }

  /**
   * 打包 profile 为自包含 `.ohb` 发布单元。
   * 收集每个插件的源目录（优先 installFrom.path；仅 url 远程源则回源时再取），
   * 写入 bundle.json + plugins/，整体压缩为 zip。提供 keyFile 时附 HMAC 签名。
   */
  public async packBundle(options: PackBundleOptions): Promise<PackBundleResult> {
    const staging = join(options.workspaceDir, '.omniharness', '.bundle-stage');
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    const pluginsStaging = join(staging, 'plugins');
    mkdirSync(pluginsStaging, { recursive: true });

    try {
      const refs: BundlePluginRef[] = [];
      for (const name of options.profile.plugins) {
        const descriptor = await options.registry.get(name);
        if (descriptor === undefined) {
          throw new Error(`打包失败：未找到插件 ${name}`);
        }
        let localPath: string | undefined;
        if (descriptor.installFrom.kind === 'path') {
          const dest = join(pluginsStaging, name);
          this.copyDir(descriptor.installFrom.path, dest);
          localPath = `plugins/${name}`;
        }
        refs.push({
          name,
          from: descriptor.source === 'bundled' ? 'bundled' : 'path',
          ...(localPath !== undefined ? { localPath } : {}),
        });
      }

      const patches: BundlePatch[] = options.profile.config
        ? Object.entries(options.profile.config).map(([key, value]) => ({ key, value }))
        : [];

      const manifest: BundleManifest = {
        name: options.profile.name,
        version: '0.1.0',
        plugins: refs,
        patches,
      };

      if (options.keyFile !== undefined) {
        const key = this.resolveKey(options.keyFile);
        (manifest as { signature?: string }).signature = this.signManifest(manifest, key);
      }

      writeFileSync(
        join(staging, 'bundle.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8',
      );

      const entries: ZipEntry[] = [];
      this.collectEntries(staging, '', entries);

      const outDir = options.outDir ?? join(options.workspaceDir, '.omniharness', 'bundles');
      mkdirSync(outDir, { recursive: true });
      const fileName = `${options.profile.name.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase() || 'bundle'}.ohb`;
      const outPath = join(outDir, fileName);
      writeFileSync(outPath, zipStore(entries));
      return { path: outPath, manifest };
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  /**
   * 解包 `.ohb`：还原插件到 pluginsDir，并写入补丁层供运行时合并。
   * 若 zipPath 附带签名且提供 keyFile，则校验（fail-closed，不匹配即抛错）。
   */
  public async unpackBundle(options: UnpackBundleOptions): Promise<UnpackBundleResult> {
    if (!existsSync(options.zipPath)) {
      throw new Error(`bundle 文件不存在: ${options.zipPath}`);
    }
    const buffer = readFileSync(options.zipPath);
    const entries = unzip(buffer);
    const manifestEntry = entries.find((e) => e.name === 'bundle.json');
    if (manifestEntry === undefined) {
      throw new Error('bundle 缺少 bundle.json');
    }
    const manifest = JSON.parse(manifestEntry.data.toString('utf8')) as BundleManifest;

    if (manifest.signature !== undefined && options.keyFile !== undefined) {
      const key = this.resolveKey(options.keyFile);
      const expected = this.signManifest(manifest, key);
      if (expected !== manifest.signature) {
        throw new Error('bundle 签名校验失败（可能被篡改）');
      }
    }

    // 还原插件目录（仅 plugins/ 前缀的条目）
    const installed: string[] = [];
    for (const entry of entries) {
      if (!entry.name.startsWith('plugins/')) {
        continue;
      }
      const rest = entry.name.slice('plugins/'.length);
      if (rest === '') {
        continue;
      }
      const sep = rest.indexOf('/');
      const pluginName = sep === -1 ? rest : rest.slice(0, sep);
      if (!installed.includes(pluginName)) {
        installed.push(pluginName);
      }
      const dest = join(options.pluginsDir, rest);
      mkdirSync(join(options.pluginsDir, pluginName), { recursive: true });
      writeFileSync(dest, entry.data);
    }

    // 写入补丁层（config 覆盖），供运行时合并
    const patchDir = join(options.workspaceDir, '.omniharness', 'bundle-patches');
    mkdirSync(patchDir, { recursive: true });
    const patchFile = join(patchDir, `${this.sanitizeId(manifest.name)}.json`);
    writeFileSync(
      patchFile,
      `${JSON.stringify({ name: manifest.name, patches: manifest.patches }, null, 2)}\n`,
      'utf8',
    );

    return { manifest, installed, patchFile };
  }

  /** 文件名归一化。 */
  private sanitizeId(name: string): string {
    const id = name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return id === '' ? 'unnamed' : id;
  }
}

// ---- 门面兼容：保留原导出名，委托默认实例 ----
const pluginBundler = new PluginBundler();

/** 打包 profile 为自包含 `.ohb` 发布单元（门面：委托默认打包器实例）。 */
export function packBundle(options: PackBundleOptions): Promise<PackBundleResult> {
  return pluginBundler.packBundle(options);
}

/** 解包 `.ohb`（门面：委托默认打包器实例）。 */
export function unpackBundle(options: UnpackBundleOptions): Promise<UnpackBundleResult> {
  return pluginBundler.unpackBundle(options);
}
