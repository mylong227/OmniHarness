// 插件集 Profile + Bundle：列出 / 应用 / 删除配置集，保存当前运行时为配置集，打包 / 解包发布单元。
//
// 面向对象改造：三个 useRef 改为实例字段；reloadKey 变化触发重载由 componentDidUpdate 比较实现
// （替代 useEffect 依赖数组），避免「依赖里塞了 reloadKey 却每次都重建回调」的闭包噪音。

import { React } from '../../deps.js';
import { AppComponent } from '../../base/AppComponent.js';
import { emptyState } from '../../format.js';
import type { Profile, ActivePlugins } from '../../../types/models.js';

export interface ProfilesTabProps {
  reloadKey: number;
}

interface ProfilesTabState {
  profiles: Profile[];
  active: ActivePlugins;
}

/** 配置集与发布单元面板。 */
export class ProfilesTab extends AppComponent<ProfilesTabProps, ProfilesTabState> {
  private nameRef: HTMLInputElement | null = null;
  private bundleProfileRef: HTMLInputElement | null = null;
  private bundleZipRef: HTMLInputElement | null = null;

  constructor(props: ProfilesTabProps) {
    super(props);
    this.state = { profiles: [], active: { plugins: [] } };
  }

  override componentDidMount(): void {
    void this.load();
  }

  override componentDidUpdate(prevProps: ProfilesTabProps): void {
    if (prevProps.reloadKey !== this.props.reloadKey) void this.load();
  }

  /** 拉取配置集列表与当前激活插件集。 */
  private async load(): Promise<void> {
    try {
      const [list, act] = await Promise.all([this.api.listProfiles(), this.api.getActiveProfile()]);
      this.setState({ profiles: list || [], active: act || { plugins: [] } });
    } catch (e) {
      this.toast('加载失败：' + (e as Error).message, 'err');
    }
  }

  /** 把当前激活插件集存成配置集；名称为空 fail-closed 提示，不发请求。 */
  private async saveCurrent(): Promise<void> {
    const name = this.nameRef ? this.nameRef.value.trim() : '';
    if (!name) {
      this.toast('请填写配置集名称', 'err');
      return;
    }
    const act = await this.api.getActiveProfile();
    try {
      await this.api.saveProfile({
        name,
        plugins: act.plugins ?? [],
        description: '保存于 Web 控制台',
      });
      this.toast('已保存配置集：' + name, 'ok');
      if (this.nameRef) this.nameRef.value = '';
      await this.load();
    } catch (e) {
      this.toast('保存失败：' + (e as Error).message, 'err');
    }
  }

  private async applyProfile(id: string): Promise<void> {
    try {
      const r = await this.api.applyProfile(id);
      this.toast(
        '已应用配置集：' +
          (r.name || id) +
          '（载入 ' +
          (r.loaded || []).length +
          '，停用 ' +
          (r.unloaded || []).length +
          '）',
        'ok',
      );
      await this.load();
    } catch (e) {
      this.toast('应用失败：' + (e as Error).message, 'err');
    }
  }

  private async delProfile(id: string): Promise<void> {
    const ok = await this.dialog.confirm('确认删除该配置集？', {
      title: '删除配置集',
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.api.deleteProfile(id);
      this.toast('已删除', 'ok');
      await this.load();
    } catch (e) {
      this.toast('删除失败：' + (e as Error).message, 'err');
    }
  }

  private async pack(): Promise<void> {
    const id = this.bundleProfileRef ? this.bundleProfileRef.value.trim() : '';
    const params = id ? { id } : { profile: { name: 'current', plugins: this.state.active.plugins ?? [] } };
    try {
      const r = await this.api.packBundle(params);
      if (this.bundleZipRef) this.bundleZipRef.value = r.path;
      this.toast('已打包：' + r.path, 'ok');
    } catch (e) {
      this.toast('打包失败：' + (e as Error).message, 'err');
    }
  }

  private async unpack(): Promise<void> {
    const zip = this.bundleZipRef ? this.bundleZipRef.value.trim() : '';
    if (!zip) {
      this.toast('请填写 zip 路径', 'err');
      return;
    }
    try {
      const r = await this.api.unpackBundle(zip);
      this.toast(
        '已解包：安装 ' +
          (r.installed || []).length +
          ' 个插件' +
          (r.patchFile ? '，补丁层已写 ' + r.patchFile : ''),
        'ok',
      );
      await this.load();
    } catch (e) {
      this.toast('解包失败：' + (e as Error).message, 'err');
    }
  }

  private renderRow(p: Profile): ReactElement {
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
          <button className="ghost" onClick={() => void this.applyProfile(p.id)}>
            应用
          </button>
          <button className="ghost" onClick={() => void this.delProfile(p.id)}>
            删除
          </button>
        </div>
      </div>
    );
  }

  override render(): ReactElement {
    const { profiles, active } = this.state;
    return (
      <div>
        <div className="pm-head">
          <button className="ghost" onClick={() => void this.load()}>
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
            ? profiles.map((p) => this.renderRow(p))
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
                  this.nameRef = el;
                }}
                placeholder="如：minimal / web-dev"
              />
            </label>
            <div className="row">
              <button className="send" onClick={() => void this.saveCurrent()}>
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
                  this.bundleProfileRef = el;
                }}
                placeholder="配置集 id 或名称"
              />
            </label>
            <div className="row">
              <button className="ghost" onClick={() => void this.pack()}>
                打包 .zip
              </button>
              <button className="ghost" onClick={() => void this.unpack()}>
                解包 .zip
              </button>
            </div>
            <label>
              解包 zip 路径
              <input
                type="text"
                ref={(el: HTMLInputElement | null) => {
                  this.bundleZipRef = el;
                }}
                placeholder=".zip 绝对路径"
              />
            </label>
          </div>
        </div>
      </div>
    );
  }
}
