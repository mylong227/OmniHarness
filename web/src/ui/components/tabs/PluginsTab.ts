// 插件市场：已安装插件管理 + 可获取插件（本地 / 内置 / 远程）搜索安装，支持重新加载。

import { html, React } from '../../deps.js';
import { useApp } from '../../context.js';
import { permChip, emptyState } from '../../format.js';
import type { PluginManifest, PluginSearchEntry } from '../../../types/models.js';

export function PluginsTab(): ReactElement {
  const { api, toast } = useApp();
  const [installed, setInstalled] = React.useState<PluginManifest[]>([]);
  const [available, setAvailable] = React.useState<PluginSearchEntry[]>([]);
  const [query, setQuery] = React.useState('');
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    Promise.all([api.listPlugins(), api.searchPlugins(query)]).then(([inst, all]) => {
      setInstalled(inst || []);
      const instSet = new Set((inst || []).map((m) => m.name));
      setAvailable((all || []).filter((d) => !instSet.has(d.manifest.name)));
    });
  }, [api, query]);

  React.useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);

  async function doAction(kind: 'install' | 'remove', name: string) {
    if (!name) return;
    setBusy(name);
    try {
      if (kind === 'install') await api.installPlugin(name);
      else await api.removePlugin(name);
      toast((kind === 'install' ? '已安装 ' : '已卸载 ') + name, 'ok');
      load();
    } catch (e) {
      toast((kind === 'install' ? '安装' : '卸载') + '失败：' + (e as Error).message, 'err');
    } finally {
      setBusy(null);
    }
  }

  async function reload() {
    setBusy('__reload__');
    try {
      const res = await api.reloadPlugins();
      if (res && res.ok && res.loaded && res.loaded.length) toast('已加载 ' + res.loaded.length + ' 个插件', 'ok');
      load();
    } catch (e) {
      toast('重新加载失败：' + (e as Error).message, 'err');
    } finally {
      setBusy(null);
    }
  }

  function card(m: PluginManifest, source: string, isInstalled: boolean): ReactElement {
    const perms = (m.permissions || []).map((p) => permChip(p));
    const status = isInstalled
      ? html`<span className=${'src-badge ' + (m.loaded ? 'loaded' : 'unloaded')}>${m.loaded ? '已加载' : '未加载'}</span>`
      : '';
    const actions = isInstalled
      ? html`<span className="pc-installed">✓ 已安装</span
          ><button className="btn-remove" disabled=${busy === m.name} onClick=${() => doAction('remove', m.name)}>卸载</button>`
      : html`<button className="btn-install" disabled=${busy === m.name} onClick=${() => doAction('install', m.name)}>安装</button>`;
    return html`<div className="plugin-card" key=${m.name}>
      <div className="pc-head">
        <span className="pc-name">${m.name}<span className="pc-ver">v${m.version}</span></span>
        <span className=${'src-badge ' + source}>${source}</span>
      </div>
      ${m.description ? html`<div className="pc-desc">${m.description}</div>` : null}
      ${m.author ? html`<div className="pc-meta">作者：${m.author}</div>` : null}
      ${perms.length ? html`<div>${perms}</div>` : null}
      <div className="pc-foot">${status}${actions}</div>
    </div>`;
  }

  return html`<div>
    <div className="pm-head">
      <input type="text" placeholder="搜索插件名 / 描述…" value=${query} onInput=${(e: Event) => setQuery((e.target as HTMLInputElement).value)} />
      <button className="ghost" disabled=${busy === '__reload__'} onClick=${reload}>重新加载</button>
      <button className="ghost" onClick=${load}>刷新</button>
    </div>
    <div className="pm-section">
      <div className="pm-title">已安装</div>
      ${installed.length
        ? installed.map((m) => card(m, m.source || 'local', true))
        : emptyState('🧩', '尚未安装任何插件', '在下方「可获取」中一键安装内置或远程插件。')}
    </div>
    <div className="pm-section">
      <div className="pm-title">可获取（本地 / 内置 / 远程）</div>
      ${available.length
        ? available.map((d) => card(d.manifest, d.source, false))
        : emptyState('🔌', '暂无可获取插件', '远程 registry 可能离线；内置示例插件始终可用。')}
    </div>
  </div>`;
}
