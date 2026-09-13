// 长期记忆管理：列出 / 检索 / 新增 / 编辑 / 删除事实记忆。reloadKey 变化（SSE memory.changed）时自动刷新。
//
// 面向对象改造：三个 useRef 改为实例字段；editingId 决定「新增 / 编辑」双态表单；
// 星级渲染抽为 ImportanceStars（零 React 依赖，可单测）。

import { React } from '../../deps.js';
import { AppComponent } from '../../base/AppComponent.js';
import { ImportanceStars } from '../../models/ImportanceStars.js';
import type { MemoryFact } from '../../../types/models.js';

export interface MemoryTabProps {
  reloadKey: number;
}

interface MemoryTabState {
  facts: MemoryFact[];
  count: number;
  query: string;
  /** 正在编辑的记忆 id；null 表示新增态。 */
  editingId: string | null;
}

/** 长期记忆面板。 */
export class MemoryTab extends AppComponent<MemoryTabProps, MemoryTabState> {
  private textRef: HTMLInputElement | null = null;
  private topicRef: HTMLInputElement | null = null;
  private impRef: HTMLSelectElement | null = null;

  constructor(props: MemoryTabProps) {
    super(props);
    this.state = { facts: [], count: 0, query: '', editingId: null };
  }

  override componentDidMount(): void {
    void this.load();
  }

  override componentDidUpdate(prevProps: MemoryTabProps): void {
    if (prevProps.reloadKey !== this.props.reloadKey) void this.load();
  }

  /** 列出全部记忆。 */
  private async load(): Promise<void> {
    try {
      const r = await this.api.listMemory();
      this.setState({ count: r.count, facts: r.facts });
    } catch (e) {
      this.toast('加载失败：' + (e as Error).message, 'err');
    }
  }

  /** 检索：空查询回落为全量列出。 */
  private async search(): Promise<void> {
    const q = this.state.query.trim();
    if (!q) {
      await this.load();
      return;
    }
    try {
      const r = await this.api.searchMemory(q, 20);
      this.setState({ count: r.count, facts: r.results });
    } catch (e) {
      this.toast('检索失败：' + (e as Error).message, 'err');
    }
  }

  /** 进入编辑态：把该条记忆回填到表单。 */
  private startEdit(f: MemoryFact): void {
    this.setState({ editingId: f.id });
    if (this.textRef) this.textRef.value = f.text;
    if (this.topicRef) this.topicRef.value = f.topic || '';
    if (this.impRef) this.impRef.value = String(f.importance || 3);
  }

  /** 复位表单到新增态。 */
  private reset(): void {
    this.setState({ editingId: null });
    if (this.textRef) this.textRef.value = '';
    if (this.topicRef) this.topicRef.value = '';
    if (this.impRef) this.impRef.value = '3';
  }

  /** 保存：按 editingId 决定新增或更新。 */
  private async save(): Promise<void> {
    const { editingId } = this.state;
    const text = this.textRef ? this.textRef.value.trim() : '';
    if (!text) {
      this.toast('请填写事实', 'err');
      return;
    }
    const topic = this.topicRef ? this.topicRef.value.trim() || undefined : undefined;
    const importance = this.impRef ? parseInt(this.impRef.value, 10) || 3 : 3;
    try {
      if (editingId) await this.api.updateMemory({ id: editingId, text, topic, importance });
      else await this.api.addMemory({ text, topic, importance });
      this.toast(editingId ? '已更新记忆' : '已保存记忆', 'ok');
      this.reset();
      await this.load();
    } catch (e) {
      this.toast('保存失败：' + (e as Error).message, 'err');
    }
  }

  private async del(id: string): Promise<void> {
    const ok = await this.dialog.confirm('确认删除这条记忆？', {
      title: '删除记忆',
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.api.deleteMemory(id);
      this.toast('已删除', 'ok');
      await this.load();
    } catch (e) {
      this.toast('删除失败：' + (e as Error).message, 'err');
    }
  }

  private renderRow(f: MemoryFact): ReactElement {
    const topic = f.topic ? <span className="badge">{f.topic}</span> : null;
    const src =
      f.source === 'consolidated' ? (
        <span className="badge b-reasoning">蒸馏</span>
      ) : (
        <span className="badge b-tool_call">手动</span>
      );
    return (
      <div className="mem-row" key={f.id} data-id={f.id}>
        <div className="mem-text">{f.text}</div>
        <div className="mem-meta">
          {topic}
          {src}
          <span className="mem-imp">{ImportanceStars.render(f.importance || 0)}</span>
          <span className="mem-time">{(f.createdAt || '').slice(0, 10)}</span>
        </div>
        <div className="mem-actions">
          <button className="ghost" onClick={() => this.startEdit(f)}>
            编辑
          </button>
          <button className="ghost" onClick={() => void this.del(f.id)}>
            删除
          </button>
        </div>
      </div>
    );
  }

  override render(): ReactElement {
    const { facts, count, query, editingId } = this.state;
    return (
      <div>
        <div className="pm-head">
          <input
            type="text"
            placeholder="检索长期记忆（自然语言）…"
            value={query}
            onInput={(e: Event) => this.setState({ query: (e.target as HTMLInputElement).value })}
          />
          <button className="ghost" onClick={() => void this.search()}>
            检索
          </button>
          <button className="ghost" onClick={() => void this.load()}>
            刷新
          </button>
        </div>
        <div className="pm-section">
          <div className="pm-title">新增 / 编辑记忆</div>
          <div className="form">
            <label>
              事实
              <input
                type="text"
                ref={(el: HTMLInputElement | null) => {
                  this.textRef = el;
                }}
                placeholder="如：用户要求所有 TS 文件用 camelCase"
              />
            </label>
            <label>
              主题
              <input
                type="text"
                ref={(el: HTMLInputElement | null) => {
                  this.topicRef = el;
                }}
                placeholder="编码规范 / 项目约定 / 环境"
              />
            </label>
            <label>
              重要度
              <select
                ref={(el: HTMLSelectElement | null) => {
                  this.impRef = el;
                }}
              >
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3" selected>
                  3
                </option>
                <option value="4">4</option>
                <option value="5">5</option>
              </select>
            </label>
            <div className="row">
              <button className="send" onClick={() => void this.save()}>
                {editingId ? '保存修改' : '保存'}
              </button>
              {editingId ? (
                <button className="ghost" onClick={() => this.reset()}>
                  取消编辑
                </button>
              ) : null}
            </div>
          </div>
        </div>
        <div className="pm-section">
          <div className="pm-title">已存记忆（{count}）</div>
          {facts.length === 0 ? (
            <div className="empty">
              暂无记忆。上方填入事实后点「保存」，或在会话中由模型自动沉淀。
            </div>
          ) : (
            facts.map((f) => this.renderRow(f))
          )}
        </div>
      </div>
    );
  }
}
