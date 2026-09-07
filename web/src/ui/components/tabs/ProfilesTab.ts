// 插件集 Profile + Bundle：列出 / 应用 / 删除配置集，保存当前运行时为配置集，打包 / 解包发布单元。

import { html, React } from '../../deps.js';
import { useApp } from '../../context.js';
import { emptyState } from '../../format.js';
import type { Profile, ActivePlugins } from '../../../types/models.js';

export interface ProfilesTabProps {
  reloadKey: number;
}

export function ProfilesTab(props: ProfilesTabProps): ReactElement {
  const { reloadKey } = props;
  const { api, toast } = useApp();
  const [profiles, setProfiles] = React.useState<Profile[]>([]);
  const [active, setActive] = React.useState<ActivePlugins>({ plugins: [] });
  const nameRef = React.useRef<HTMLInputElement | null>(null);
  const bundleProfileRef = React.useRef<HTMLInputElement | null>(null);
  const bundleZipRef = React.useRef<HTMLInputElement | null>(null);

  const load = React.useCallback(() => {
    Promise.all([api.listProfiles(), api.getActiveProfile()])
      .then(([list, act]) => {
        setProfiles(list || []);
        setActive(act || { plugins: [] });
      })
      .catch((e: Error) => toast('加载失败：' + e.message, 'err'));
  }, [api, toast]);

  React.useEffect(() => {
    load();
  }, [load, reloadKey]);

  async function saveCurrent() {
    const name = nameRef.current ? nameRef.current.value.trim() : '';
    if (!name) {
      toast('请填写配置集名称', 'err');
      return;
    }
    const act = await api.getActiveProfile();
    try {
      await api.saveProfile({ name, plugins: act.plugins ?? [], description: '保存于 Web 控制台' });
      toast('已保存配置集：' + name, 'ok');
      if (nameRef.current) nameRef.current.value = '';
      load();
    } catch (e) {
      toast('保存失败：' + (e as Error).message, 'err');
    }
  }

  async function applyProfile(id: string) {
    try {
      const r = await api.applyProfile(id);
      toast('已应用配置集：' + (r.name || id) + '（载入 ' + (r.loaded || []).length + '，停用 ' + (r.unloaded || []).length + '）', 'ok');
      load();
    } catch (e) {
      toast('应用失败：' + (e as Error).message, 'err');
    }
  }

  async function delProfile(id: string) {
    if (!window.confirm('确认删除该配置集？')) return;
    try {
      await api.deleteProfile(id);
      toast('已删除', 'ok');
      load();
    } catch (e) {
      toast('删除失败：' + (e as Error).message, 'err');
    }
  }

  async function pack() {
    const id = bundleProfileRef.current ? bundleProfileRef.current.value.trim() : '';
    const params = id ? { id } : { profile: { name: 'current', plugins: active.plugins ?? [] } };
    try {
      const r = await api.packBundle(params);
      if (bundleZipRef.current) bundleZipRef.current.value = r.path;
      toast('已打包：' + r.path, 'ok');
    } catch (e) {
      toast('打包失败：' + (e as Error).message, 'err');
    }
  }

  async function unpack() {
    const zip = bundleZipRef.current ? bundleZipRef.current.value.trim() : '';
    if (!zip) {
      toast('请填写 zip 路径', 'err');
      return;
    }
    try {
      const r = await api.unpackBundle(zip);
      toast('已解包：安装 ' + (r.installed || []).length + ' 个插件' + (r.patchFile ? '，补丁层已写 ' + r.patchFile : ''), 'ok');
      load();
    } catch (e) {
      toast('解包失败：' + (e as Error).message, 'err');
    }
  }

  function row(p: Profile): ReactElement {
    const plugs = (p.plugins || []).map((n) => html`<span className="badge" key=${n}>${n}</span>`);
    return html`<div className="mem-row" key=${p.id} data-id=${p.id}>
      <div className="mem-text">${p.name}</div>
      ${p.description ? html`<div className="mem-meta">${p.description}</div>` : null}
      <div className="mem-meta">${plugs}</div>
      <div className="mem-actions">
        <button className="ghost" onClick=${() => applyProfile(p.id)}>应用</button>
        <button className="ghost" onClick=${() => delProfile(p.id)}>删除</button>
      </div>
    </div>`;
  }

  return html`<div>
    <div className="pm-head">
      <button className="ghost" onClick=${load}>刷新</button>
      <span className="dim"
        >运行时插件（${active.plugins?.length || 0}）：${active.plugins?.length ? active.plugins.join(', ') : '—'}</span
      >
    </div>
    <div className="pm-section">
      <div className="pm-title">已存配置集（${profiles.length}）</div>
      ${profiles.length
        ? profiles.map(row)
        : emptyState('📦', '暂无配置集', '在下方「保存当前为配置集」创建，或用 CLI --plugin-profile 指定。')}
    </div>
    <div className="pm-section">
      <div className="pm-title">保存当前运行时为配置集</div>
      <div className="form">
        <label>名称<input type="text" ref=${nameRef} placeholder="如：minimal / web-dev" /></label>
        <div className="row"><button className="send" onClick=${saveCurrent}>保存当前为配置集</button></div>
      </div>
    </div>
    <div className="pm-section">
      <div className="pm-title">Bundle 发布单元（可 patch 插件叠层）</div>
      <div className="form">
        <label>配置集（留空=当前激活）<input type="text" ref=${bundleProfileRef} placeholder="配置集 id 或名称" /></label>
        <div className="row">
          <button className="ghost" onClick=${pack}>打包 .zip</button>
          <button className="ghost" onClick=${unpack}>解包 .zip</button>
        </div>
        <label>解包 zip 路径<input type="text" ref=${bundleZipRef} placeholder=".zip 绝对路径" /></label>
      </div>
    </div>
  </div>`;
}
