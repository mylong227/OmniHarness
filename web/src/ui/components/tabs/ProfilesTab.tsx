// 插件集 Profile + Bundle：列出 / 应用 / 删除配置集，保存当前运行时为配置集，打包 / 解包发布单元。
//
// 函数组件范式：配置集列表与当前激活插件集各一个 useState；表单三处输入为非受控（useRef 读写）；
// 「挂载装载 + reloadKey 变化重载」合为一个依赖 reloadKey 的 effect；行渲染下沉为模块级函数。

import { React } from '../../deps.js';
import { useApp } from '../../context.js';
import { emptyState } from '../../format.js';
import type { Profile, ActivePlugins } from '../../../types/models.js';

/** ProfilesTab 组件的入参。 */
export interface ProfilesTabProps {
  /** 外部重载信号（SSE profile 事件时自增，触发重新拉取）。 */
  reloadKey: number;
}

/** 行渲染所需的回调。 */
interface RowActions {
  /** 应用该配置集。 */
  onApply: (id: string) => void;
  /** 删除该配置集。 */
  onDelete: (id: string) => void;
}

/**
 * 渲染单个配置集行：名称 + 描述 + 插件徽标 + 操作。
 * @param p 配置集
 * @param actions 应用 / 删除回调
 * @returns 配置集行节点
 */
function renderRow(p: Profile, actions: RowActions): ReactElement {
  const plugs = (p.plugins || []).map((n) => (
    <span className="badge" key={n}>
      {n}
    </span>
  ));
  return (
    <div className="mem-row" key={p.id} data-id={p.id}>
      <div className="mem-text">{p.name}</div>
      {p.description ? <div className="mem-meta">{p.description}</div> : null}
      <div className="mem-meta">{plugs}</div>
      <div className="mem-actions">
        <button className="ghost" onClick={() => actions.onApply(p.id)}>
          应用
        </button>
        <button className="ghost" onClick={() => actions.onDelete(p.id)}>
          删除
        </button>
      </div>
    </div>
  );
}

/**
 * 配置集与发布单元面板：保存 / 应用 / 删除配置集，打包与解包 Bundle。
 * @param props 组件入参
 * @returns 配置集面板节点
 */
export function ProfilesTab(props: ProfilesTabProps): ReactElement {
  const { reloadKey } = props;
  const { api, toast, dialog } = useApp();
  const [profiles, setProfiles] = React.useState<Profile[]>([]);
  const [active, setActive] = React.useState<ActivePlugins>({ plugins: [] });
  const nameRef = React.useRef<HTMLInputElement | null>(null);
  const bundleProfileRef = React.useRef<HTMLInputElement | null>(null);
  const bundleZipRef = React.useRef<HTMLInputElement | null>(null);

  /** 拉取配置集列表与当前激活插件集。 */
  const load = async (): Promise<void> => {
    try {
      const [list, act] = await Promise.all([api.listProfiles(), api.getActiveProfile()]);
      setProfiles(list || []);
      setActive(act || { plugins: [] });
    } catch (e) {
      toast('加载失败：' + (e as Error).message, 'err');
    }
  };

  // 挂载装载 + reloadKey 变化重载（deps 只有 reloadKey；load 只读写闭包外的服务与 setter）。
  React.useEffect(() => {
    void load();
  }, [reloadKey]);

  /** 把当前激活插件集存成配置集；名称为空 fail-closed 提示，不发请求。 */
  const saveCurrent = async (): Promise<void> => {
    const name = nameRef.current ? nameRef.current.value.trim() : '';
    if (!name) {
      toast('请填写配置集名称', 'err');
      return;
    }
    const act = await api.getActiveProfile();
    try {
      await api.saveProfile({
        name,
        plugins: act.plugins ?? [],
        description: '保存于 Web 控制台',
      });
      toast('已保存配置集：' + name, 'ok');
      if (nameRef.current) nameRef.current.value = '';
      await load();
    } catch (e) {
      toast('保存失败：' + (e as Error).message, 'err');
    }
  };

  /**
   * 应用配置集并提示载入 / 停用数量。
   * @param id 配置集 id
   */
  const applyProfile = async (id: string): Promise<void> => {
    try {
      const r = await api.applyProfile(id);
      toast(
        '已应用配置集：' +
          (r.name || id) +
          '（载入 ' +
          (r.loaded || []).length +
          '，停用 ' +
          (r.unloaded || []).length +
          '）',
        'ok',
      );
      await load();
    } catch (e) {
      toast('应用失败：' + (e as Error).message, 'err');
    }
  };

  /**
   * 删除配置集（先经 DialogService 确认）。
   * @param id 配置集 id
   */
  const delProfile = async (id: string): Promise<void> => {
    const ok = await dialog.confirm('确认删除该配置集？', {
      title: '删除配置集',
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteProfile(id);
      toast('已删除', 'ok');
      await load();
    } catch (e) {
      toast('删除失败：' + (e as Error).message, 'err');
    }
  };

  /** 打包：指定配置集 id，或退化为「当前激活」快照。 */
  const pack = async (): Promise<void> => {
    const id = bundleProfileRef.current ? bundleProfileRef.current.value.trim() : '';
    const params = id ? { id } : { profile: { name: 'current', plugins: active.plugins ?? [] } };
    try {
      const r = await api.packBundle(params);
      if (bundleZipRef.current) bundleZipRef.current.value = r.path;
      toast('已打包：' + r.path, 'ok');
    } catch (e) {
      toast('打包失败：' + (e as Error).message, 'err');
    }
  };

  /** 解包：按 zip 路径安装插件并可能写入补丁层。 */
  const unpack = async (): Promise<void> => {
    const zip = bundleZipRef.current ? bundleZipRef.current.value.trim() : '';
    if (!zip) {
      toast('请填写 zip 路径', 'err');
      return;
    }
    try {
      const r = await api.unpackBundle(zip);
      toast(
        '已解包：安装 ' +
          (r.installed || []).length +
          ' 个插件' +
          (r.patchFile ? '，补丁层已写 ' + r.patchFile : ''),
        'ok',
      );
      await load();
    } catch (e) {
      toast('解包失败：' + (e as Error).message, 'err');
    }
  };

  return (
    <div>
      <div className="pm-head">
        <button className="ghost" onClick={() => void load()}>
          刷新
        </button>
        <span className="dim">
          运行时插件（{active.plugins?.length || 0}）：
          {active.plugins?.length ? active.plugins.join(', ') : '—'}
        </span>
      </div>
      <div className="pm-section">
        <div className="pm-title">已存配置集（{profiles.length}）</div>
        {profiles.length
          ? profiles.map((p) =>
              renderRow(p, { onApply: (id) => void applyProfile(id), onDelete: (id) => void delProfile(id) }),
            )
          : emptyState(
              '📦',
              '暂无配置集',
              '在下方「保存当前为配置集」创建，或用 CLI --plugin-profile 指定。',
            )}
      </div>
      <div className="pm-section">
        <div className="pm-title">保存当前运行时为配置集</div>
        <div className="form">
          <label>
            名称
            <input
              type="text"
              ref={(el: HTMLInputElement | null) => {
                nameRef.current = el;
              }}
              placeholder="如：minimal / web-dev"
            />
          </label>
          <div className="row">
            <button className="send" onClick={() => void saveCurrent()}>
              保存当前为配置集
            </button>
          </div>
        </div>
      </div>
      <div className="pm-section">
        <div className="pm-title">Bundle 发布单元（可 patch 插件叠层）</div>
        <div className="form">
          <label>
            配置集（留空=当前激活）
            <input
              type="text"
              ref={(el: HTMLInputElement | null) => {
                bundleProfileRef.current = el;
              }}
              placeholder="配置集 id 或名称"
            />
          </label>
          <div className="row">
            <button className="ghost" onClick={() => void pack()}>
              打包 .zip
            </button>
            <button className="ghost" onClick={() => void unpack()}>
              解包 .zip
            </button>
          </div>
          <label>
            解包 zip 路径
            <input
              type="text"
              ref={(el: HTMLInputElement | null) => {
                bundleZipRef.current = el;
              }}
              placeholder=".zip 绝对路径"
            />
          </label>
        </div>
      </div>
    </div>
  );
}
