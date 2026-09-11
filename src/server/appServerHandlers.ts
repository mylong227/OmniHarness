import { loadInstalledPlugins } from '../plugin/pluginLoader.js';
import { PluginProfileStore, applyProfile, type PluginProfile } from '../plugin/pluginProfileStore.js';
import { packBundle, unpackBundle } from '../plugin/pluginBundler.js';
import { jsonRpc } from './jsonRpc.js';
import { AppServerBase } from './appServerBase.js';

/**
 * AppServer 后半段处理器：插件集 Profile / Bundle 发布单元 / 插件市场。
 * 继承自 AppServerBase，方法体逐字节等价于原 appServer.ts。
 */
export class AppServerHandlers extends AppServerBase {
  /** 插件集 Profile RPC（G-E 5.1，对标 dsh 命名插件组合）：增删查 + 应用 + 当前激活集。 */
  protected registerProfileHandlers(): void {
    const workspaceRoot = () => this.displayConfig['workspace'] ?? process.cwd();
    const storeOf = () => new PluginProfileStore(workspaceRoot());

    this.handlers.set('profile.list', async () => storeOf().list());
    this.handlers.set('profile.get', async (params) => {
      const id = params['id'];
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error('profile.get 需要 id');
      }
      return storeOf().get(id);
    });
    this.handlers.set('profile.save', async (params) => {
      const profile = params['profile'] as PluginProfile | undefined;
      if (profile === undefined || typeof profile.name !== 'string') {
        throw new Error('profile.save 需要 profile.name');
      }
      return { id: storeOf().save(profile) };
    });
    this.handlers.set('profile.delete', async (params) => {
      const id = params['id'];
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error('profile.delete 需要 id');
      }
      return { ok: storeOf().delete(id) };
    });
    this.handlers.set('profile.active', async () => {
      await this.plugins.ensure();
      return { plugins: this.pluginManager?.names() ?? [] };
    });
    this.handlers.set('profile.apply', async (params) => {
      await this.plugins.ensure();
      const registry = this.options.registry;
      const manager = this.pluginManager;
      const pluginsDir = this.pluginsDir;
      if (registry === undefined || manager === undefined || pluginsDir === undefined) {
        throw new Error('插件系统未初始化（serve 需注入 registry/pluginsDir）');
      }
      // 解析 profile：优先 store 内按 id，其次内联 profile 对象
      let profile: PluginProfile | undefined;
      const idOrName = params['id'];
      if (typeof idOrName === 'string' && idOrName.length > 0) {
        profile = storeOf().get(idOrName);
      }
      if (
        profile === undefined &&
        (params['profile'] as PluginProfile | undefined)?.name !== undefined
      ) {
        profile = params['profile'] as PluginProfile;
      }
      if (profile === undefined) {
        throw new Error('profile.apply 需要有效的 id 或内联 profile');
      }
      const result = await applyProfile(manager, pluginsDir, registry, profile, {
        onInstall: (name) =>
          this.options.transport.send(jsonRpc.notify('profile.event', { type: 'install', name })),
        onLoad: (name) =>
          this.options.transport.send(jsonRpc.notify('profile.event', { type: 'load', name })),
        onUnload: (name) =>
          this.options.transport.send(jsonRpc.notify('profile.event', { type: 'unload', name })),
        onError: (name, error) =>
          this.options.transport.send(
            jsonRpc.notify('profile.error', { name, error: this.messageOf(error) }),
          ),
      });
      this.options.transport.send(
        jsonRpc.notify('profile.applied', { name: profile.name, ...result }),
      );
      return result;
    });
  }

  /** Bundle 发布单元 RPC（G-E 5.2/5.3，对标 dsh 可 patch 插件叠层 + 发布单元）。 */
  protected registerBundleHandlers(): void {
    const workspaceRoot = () => this.displayConfig['workspace'] ?? process.cwd();
    const storeOf = () => new PluginProfileStore(workspaceRoot());

    this.handlers.set('bundle.pack', async (params) => {
      const registry = this.options.registry;
      const pluginsDir = this.pluginsDir;
      if (registry === undefined || pluginsDir === undefined) {
        throw new Error('插件系统未初始化（serve 需注入 registry/pluginsDir）');
      }
      // 解析 profile：store 内按 id，或内联 profile 对象
      let profile: PluginProfile | undefined;
      const idOrName = params['id'];
      if (typeof idOrName === 'string' && idOrName.length > 0) {
        profile = storeOf().get(idOrName);
      }
      if (
        profile === undefined &&
        (params['profile'] as PluginProfile | undefined)?.name !== undefined
      ) {
        profile = params['profile'] as PluginProfile;
      }
      if (profile === undefined) {
        throw new Error('bundle.pack 需要有效的 id 或内联 profile');
      }
      const keyFile = typeof params['keyFile'] === 'string' ? params['keyFile'] : undefined;
      const result = await packBundle({
        workspaceDir: workspaceRoot(),
        profile,
        registry,
        pluginsDir,
        keyFile,
      });
      return { path: result.path, manifest: result.manifest };
    });
    this.handlers.set('bundle.unpack', async (params) => {
      const zipPath = params['zipPath'];
      const pluginsDir = this.pluginsDir;
      if (typeof zipPath !== 'string' || zipPath.length === 0) {
        throw new Error('bundle.unpack 需要 zipPath');
      }
      if (pluginsDir === undefined) {
        throw new Error('插件系统未初始化（serve 需注入 pluginsDir）');
      }
      const keyFile = typeof params['keyFile'] === 'string' ? params['keyFile'] : undefined;
      const result = await unpackBundle({
        zipPath,
        pluginsDir,
        workspaceDir: workspaceRoot(),
        keyFile,
      });
      return {
        manifest: result.manifest,
        installed: result.installed,
        patchFile: result.patchFile,
      };
    });
  }

  /** 插件市场 RPC：registry 未注入则不暴露（保持可选依赖）。 */
  protected registerPluginHandlers(): void {
    const registry = this.options.registry;
    if (registry === undefined) {
      return;
    }
    this.handlers.set('plugins.list', async () => {
      await this.plugins.ensure();
      const list = await registry.list();
      const loaded = new Set(this.pluginManager?.names() ?? []);
      return list.map((m) => ({ ...m, loaded: loaded.has(m.name) }));
    });
    this.handlers.set('plugins.search', async (params) => {
      await this.plugins.ensure();
      const query = typeof params['query'] === 'string' ? params['query'] : undefined;
      const all = await registry.search(query);
      const loaded = new Set(this.pluginManager?.names() ?? []);
      return all.map((d) => ({
        ...d,
        manifest: { ...d.manifest, loaded: loaded.has(d.manifest.name) },
      }));
    });
    this.handlers.set('plugins.install', (params) => {
      const name = params['name'];
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error('plugins.install 需要 name');
      }
      return registry.install(name);
    });
    this.handlers.set('plugins.remove', (params) => {
      const name = params['name'];
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error('plugins.remove 需要 name');
      }
      return registry.remove(name).then(() => ({ ok: true, name }));
    });
    this.handlers.set('plugins.reload', async () => {
      await this.plugins.ensure();
      if (this.pluginManager === undefined || this.pluginsDir === undefined) {
        return { ok: false, reason: '插件目录未配置' };
      }
      const loaded = await loadInstalledPlugins(
        this.pluginManager,
        this.pluginsDir,
        (name, error) =>
          this.options.transport.send(
            jsonRpc.notify('plugin.loadError', { name, error: this.messageOf(error) }),
          ),
      );
      if (loaded.length > 0) {
        this.options.transport.send(
          jsonRpc.notify('plugin.loaded', { names: loaded, reloaded: true }),
        );
      }
      return { ok: true, loaded };
    });
  }
}
