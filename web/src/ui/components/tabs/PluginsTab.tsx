// 插件市场：已安装插件管理 + 可获取插件（本地 / 内置 / 远程）搜索安装，支持重新加载。
//
// 函数组件范式：四份 state 各用 useState；搜索防抖从「useEffect 依赖数组」改为
// 「输入时重排定时器」，定时器句柄存 useRef，卸载时清理，语义等价且无闭包陷阱
// （load 显式接收 query 参数，不依赖渲染快照）；卡片渲染下沉为模块级函数。

import { React } from '../../deps.js';
import { useApp } from '../../context.js';
import { permChip, emptyState } from '../../format.js';
import type { PluginManifest, PluginSearchEntry } from '../../../types/models.js';

/** 搜索输入防抖延迟（ms）。 */
const DEBOUNCE_MS = 200;

/** 卡片渲染所需的上下文与回调。 */
interface CardActions {
  /** 插件来源徽标（local / builtin / remote）。 */
  source: string;
  /** 是否已安装（决定展示「卸载」还是「安装」）。 */
  isInstalled: boolean;
  /** 正在执行操作的插件名；'__reload__' 表示整体重载中。 */
  busy: string | null;
  /** 安装 / 卸载。 */
  onAction: (kind: 'install' | 'remove', name: string) => void;
}

/**
 * 单个插件卡片：安装态决定展示状态徽章与操作按钮。
 * @param m 插件清单
 * @param actions 卡片上下文与回调
 * @returns 插件卡片节点
 */
function renderCard(m: PluginManifest, actions: CardActions): ReactElement {
  const perms = (m.permissions || []).map((p) => permChip(p));
  const disabled = actions.busy === m.name;
  return (
    <div className="plugin-card" key={m.name}>
      <div className="pc-head">
        <span className="pc-name">
          {m.name}
          <span className="pc-ver">v{m.version}</span>
        </span>
        <span className={'src-badge ' + actions.source}>{actions.source}</span>
      </div>
      {m.description ? <div className="pc-desc">{m.description}</div> : null}
      {m.author ? <div className="pc-meta">作者：{m.author}</div> : null}
      {perms.length ? <div>{perms}</div> : null}
      <div className="pc-foot">
        {actions.isInstalled ? (
          <span className={'src-badge ' + (m.loaded ? 'loaded' : 'unloaded')}>
            {m.loaded ? '已加载' : '未加载'}
          </span>
        ) : null}
        {actions.isInstalled ? (
          <>
            <span className="pc-installed">✓ 已安装</span>
            <button
              className="btn-remove"
              disabled={disabled}
              onClick={() => actions.onAction('remove', m.name)}
            >
              卸载
            </button>
          </>
        ) : (
          <button
            className="btn-install"
            disabled={disabled}
            onClick={() => actions.onAction('install', m.name)}
          >
            安装
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * 插件市场面板：搜索、安装 / 卸载、重新加载本地 / 内置 / 远程插件。
 * @returns 插件市场节点
 */
export function PluginsTab(): ReactElement {
  const { api, toast } = useApp();
  const [installed, setInstalled] = React.useState<PluginManifest[]>([]);
  const [available, setAvailable] = React.useState<PluginSearchEntry[]>([]);
  const [query, setQuery] = React.useState<string>('');
  /** 正在执行操作的插件名；'__reload__' 表示整体重载中。 */
  const [busy, setBusy] = React.useState<string | null>(null);
  /** 防抖定时器句柄（未触发前必须可被后续输入取消）。 */
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * 拉取已安装 + 可获取列表；已安装的从「可获取」中剔除。
   * @param q 搜索关键词（显式传参，避免依赖渲染快照）
   */
  const load = async (q: string): Promise<void> => {
    const [inst, all] = await Promise.all([api.listPlugins(), api.searchPlugins(q)]);
    const list = inst || [];
    const instSet = new Set(list.map((m) => m.name));
    setInstalled(list);
    setAvailable((all || []).filter((d) => !instSet.has(d.manifest.name)));
  };

  /**
   * 排定一次延迟加载：取消上一轮未完成的任务，避免快速输入产生请求风暴。
   * @param q 搜索关键词
   */
  const scheduleLoad = (q: string): void => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void load(q);
    }, DEBOUNCE_MS);
  };

  // 挂载排定首次加载；卸载清理未触发的防抖任务（[] 有意：只挂一次）。
  React.useEffect(() => {
    scheduleLoad('');
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  /**
   * 安装 / 卸载：置忙 → 执行 → 提示 → 刷新；失败不吞（toast 上抛，finally 保证解忙）。
   * @param kind 操作类型
   * @param name 插件名
   */
  const doAction = async (kind: 'install' | 'remove', name: string): Promise<void> => {
    if (!name) return;
    setBusy(name);
    try {
      if (kind === 'install') await api.installPlugin(name);
      else await api.removePlugin(name);
      toast((kind === 'install' ? '已安装 ' : '已卸载 ') + name, 'ok');
      await load(query);
    } catch (e) {
      toast((kind === 'install' ? '安装' : '卸载') + '失败：' + (e as Error).message, 'err');
    } finally {
      setBusy(null);
    }
  };

  /** 重新加载全部插件。 */
  const reload = async (): Promise<void> => {
    setBusy('__reload__');
    try {
      const res = await api.reloadPlugins();
      if (res && res.ok && res.loaded && res.loaded.length) {
        toast('已加载 ' + res.loaded.length + ' 个插件', 'ok');
      }
      await load(query);
    } catch (e) {
      toast('重新加载失败：' + (e as Error).message, 'err');
    } finally {
      setBusy(null);
    }
  };

  /**
   * 搜索输入：更新受控值并重排防抖任务。
   * @param e 输入事件
   */
  const onQueryInput = (e: Event): void => {
    const v = (e.target as HTMLInputElement).value;
    setQuery(v);
    scheduleLoad(v);
  };

  const cardActions = (source: string, isInstalled: boolean): CardActions => ({
    source,
    isInstalled,
    busy,
    onAction: (kind, name) => void doAction(kind, name),
  });

  return (
    <div>
      <div className="pm-head">
        <input
          type="text"
          placeholder="搜索插件名 / 描述…"
          value={query}
          onInput={onQueryInput}
        />
        <button className="ghost" disabled={busy === '__reload__'} onClick={() => void reload()}>
          重新加载
        </button>
        <button className="ghost" onClick={() => void load(query)}>
          刷新
        </button>
      </div>
      <div className="pm-section">
        <div className="pm-title">已安装</div>
        {installed.length
          ? installed.map((m) => renderCard(m, cardActions(m.source || 'local', true)))
          : emptyState('🧩', '尚未安装任何插件', '在下方「可获取」中一键安装内置或远程插件。')}
      </div>
      <div className="pm-section">
        <div className="pm-title">可获取（本地 / 内置 / 远程）</div>
        {available.length
          ? available.map((d) => renderCard(d.manifest, cardActions(d.source, false)))
          : emptyState('🔌', '暂无可获取插件', '远程 registry 可能离线；内置示例插件始终可用。')}
      </div>
    </div>
  );
}
