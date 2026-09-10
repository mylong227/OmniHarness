// 插件市场：已安装插件管理 + 可获取插件（本地 / 内置 / 远程）搜索安装，支持重新加载。
//
// 面向对象改造：继承 AppComponent（替代 useApp）；四份 state 合并为单一 state 对象；
// 搜索防抖从 useEffect 依赖数组改为「输入时重排定时器」，卸载时清理，语义等价且无闭包陷阱。

import { React } from '../../deps.js';
import { AppComponent } from '../../base/AppComponent.js';
import { permChip, emptyState } from '../../format.js';
import type { PluginManifest, PluginSearchEntry } from '../../../types/models.js';

interface PluginsTabState {
  installed: PluginManifest[];
  available: PluginSearchEntry[];
  query: string;
  /** 正在执行操作的插件名；'__reload__' 表示整体重载中。 */
  busy: string | null;
}

/** 搜索输入防抖延迟（ms）。 */
const DEBOUNCE_MS = 200;

/** 插件市场面板。 */
export class PluginsTab extends AppComponent<Record<string, never>, PluginsTabState> {
  /** 防抖定时器句柄（未触发前必须可被后续输入取消）。 */
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(props: Record<string, never>) {
    super(props);
    this.state = { installed: [], available: [], query: '', busy: null };
  }

  override componentDidMount(): void {
    this.scheduleLoad();
  }

  override componentWillUnmount(): void {
    if (this.timer !== null) clearTimeout(this.timer);
  }

  /** 排定一次延迟加载：取消上一轮未完成的任务，避免快速输入产生请求风暴。 */
  private scheduleLoad(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.load();
    }, DEBOUNCE_MS);
  }

  /** 拉取已安装 + 可获取列表；已安装的从「可获取」中剔除。 */
  private async load(): Promise<void> {
    const { query } = this.state;
    const [inst, all] = await Promise.all([this.api.listPlugins(), this.api.searchPlugins(query)]);
    const installed = inst || [];
    const instSet = new Set(installed.map((m) => m.name));
    this.setState({
      installed,
      available: (all || []).filter((d) => !instSet.has(d.manifest.name)),
    });
  }

  /** 安装 / 卸载：置忙 → 执行 → 提示 → 刷新；失败不吞（toast 上抛，finally 保证解忙）。 */
  private async doAction(kind: 'install' | 'remove', name: string): Promise<void> {
    if (!name) return;
    this.setState({ busy: name });
    try {
      if (kind === 'install') await this.api.installPlugin(name);
      else await this.api.removePlugin(name);
      this.toast((kind === 'install' ? '已安装 ' : '已卸载 ') + name, 'ok');
      await this.load();
    } catch (e) {
      this.toast((kind === 'install' ? '安装' : '卸载') + '失败：' + (e as Error).message, 'err');
    } finally {
      this.setState({ busy: null });
    }
  }

  /** 重新加载全部插件。 */
  private async reload(): Promise<void> {
    this.setState({ busy: '__reload__' });
    try {
      const res = await this.api.reloadPlugins();
      if (res && res.ok && res.loaded && res.loaded.length) {
        this.toast('已加载 ' + res.loaded.length + ' 个插件', 'ok');
      }
      await this.load();
    } catch (e) {
      this.toast('重新加载失败：' + (e as Error).message, 'err');
    } finally {
      this.setState({ busy: null });
    }
  }

  private readonly onQueryInput = (e: Event): void => {
    this.setState({ query: (e.target as HTMLInputElement).value }, () => this.scheduleLoad());
  };

  /** 单个插件卡片：安装态决定展示状态徽章与操作按钮。 */
  private renderCard(m: PluginManifest, source: string, isInstalled: boolean): ReactElement {
    const { busy } = this.state;
    const perms = (m.permissions || []).map((p) => permChip(p));
    const disabled = busy === m.name;
    return (
      <div className="plugin-card" key={m.name}>
        <div className="pc-head">
          <span className="pc-name">
            {m.name}
            <span className="pc-ver">v{m.version}</span>
          </span>
          <span className={'src-badge ' + source}>{source}</span>
        </div>
        {m.description ? <div className="pc-desc">{m.description}</div> : null}
        {m.author ? <div className="pc-meta">作者：{m.author}</div> : null}
        {perms.length ? <div>{perms}</div> : null}
        <div className="pc-foot">
          {isInstalled ? (
            <span className={'src-badge ' + (m.loaded ? 'loaded' : 'unloaded')}>
              {m.loaded ? '已加载' : '未加载'}
            </span>
          ) : null}
          {isInstalled ? (
            <>
              <span className="pc-installed">✓ 已安装</span>
              <button
                className="btn-remove"
                disabled={disabled}
                onClick={() => void this.doAction('remove', m.name)}
              >
                卸载
              </button>
            </>
          ) : (
            <button
              className="btn-install"
              disabled={disabled}
              onClick={() => void this.doAction('install', m.name)}
            >
              安装
            </button>
          )}
        </div>
      </div>
    );
  }

  override render(): ReactElement {
    const { installed, available, query, busy } = this.state;
    return (
      <div>
        <div className="pm-head">
          <input
            type="text"
            placeholder="搜索插件名 / 描述…"
            value={query}
            onInput={this.onQueryInput}
          />
          <button
            className="ghost"
            disabled={busy === '__reload__'}
            onClick={() => void this.reload()}
          >
            重新加载
          </button>
          <button className="ghost" onClick={() => void this.load()}>
            刷新
          </button>
        </div>
        <div className="pm-section">
          <div className="pm-title">已安装</div>
          {installed.length
            ? installed.map((m) => this.renderCard(m, m.source || 'local', true))
            : emptyState('🧩', '尚未安装任何插件', '在下方「可获取」中一键安装内置或远程插件。')}
        </div>
        <div className="pm-section">
          <div className="pm-title">可获取（本地 / 内置 / 远程）</div>
          {available.length
            ? available.map((d) => this.renderCard(d.manifest, d.source, false))
            : emptyState('🔌', '暂无可获取插件', '远程 registry 可能离线；内置示例插件始终可用。')}
        </div>
      </div>
    );
  }
}
