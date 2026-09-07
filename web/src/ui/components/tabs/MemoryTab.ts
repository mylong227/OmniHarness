// 长期记忆管理：列出 / 检索 / 新增 / 编辑 / 删除事实记忆。reloadKey 变化（SSE memory.changed）时自动刷新。

import { html, React } from '../../deps.js';
import { useApp } from '../../context.js';
import { emptyState } from '../../format.js';
import type { MemoryFact } from '../../../types/models.js';

export interface MemoryTabProps {
  reloadKey: number;
}

export function MemoryTab(props: MemoryTabProps): ReactElement {
  const { reloadKey } = props;
  const { api, toast } = useApp();
  const [facts, setFacts] = React.useState<MemoryFact[]>([]);
  const [count, setCount] = React.useState(0);
  const [query, setQuery] = React.useState('');
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const textRef = React.useRef<HTMLInputElement | null>(null);
  const topicRef = React.useRef<HTMLInputElement | null>(null);
  const impRef = React.useRef<HTMLSelectElement | null>(null);

  const load = React.useCallback(() => {
    api
      .listMemory()
      .then((r) => {
        setCount(r.count);
        setFacts(r.facts);
      })
      .catch((e: Error) => toast('加载失败：' + e.message, 'err'));
  }, [api, toast]);

  React.useEffect(() => {
    load();
  }, [load, reloadKey]);

  async function search() {
    const q = query.trim();
    if (!q) {
      load();
      return;
    }
    try {
      const r = await api.searchMemory(q, 20);
      setCount(r.count);
      setFacts(r.results);
    } catch (e) {
      toast('检索失败：' + (e as Error).message, 'err');
    }
  }

  function startEdit(f: MemoryFact) {
    setEditingId(f.id);
    if (textRef.current) textRef.current.value = f.text;
    if (topicRef.current) topicRef.current.value = f.topic || '';
    if (impRef.current) impRef.current.value = String(f.importance || 3);
  }

  function reset() {
    setEditingId(null);
    if (textRef.current) textRef.current.value = '';
    if (topicRef.current) topicRef.current.value = '';
    if (impRef.current) impRef.current.value = '3';
  }

  async function save() {
    const text = textRef.current ? textRef.current.value.trim() : '';
    if (!text) {
      toast('请填写事实', 'err');
      return;
    }
    const topic = topicRef.current ? topicRef.current.value.trim() || undefined : undefined;
    const importance = impRef.current ? parseInt(impRef.current.value, 10) || 3 : 3;
    try {
      if (editingId) await api.updateMemory({ id: editingId, text, topic, importance });
      else await api.addMemory({ text, topic, importance });
      toast(editingId ? '已更新记忆' : '已保存记忆', 'ok');
      reset();
      load();
    } catch (e) {
      toast('保存失败：' + (e as Error).message, 'err');
    }
  }

  async function del(id: string) {
    if (!window.confirm('确认删除这条记忆？')) return;
    try {
      await api.deleteMemory(id);
      toast('已删除', 'ok');
      load();
    } catch (e) {
      toast('删除失败：' + (e as Error).message, 'err');
    }
  }

  function row(f: MemoryFact): ReactElement {
    const topic = f.topic ? html`<span className="badge">${f.topic}</span>` : '';
    const src =
      f.source === 'consolidated'
        ? html`<span className="badge b-reasoning">蒸馏</span>`
        : html`<span className="badge b-tool_call">手动</span>`;
    const imp = '★'.repeat(f.importance || 0) + '☆'.repeat(5 - (f.importance || 0));
    return html`<div className="mem-row" key=${f.id} data-id=${f.id}>
      <div className="mem-text">${f.text}</div>
      <div className="mem-meta">
        ${topic}${src}<span className="mem-imp">${imp}</span
        ><span className="mem-time">${(f.createdAt || '').slice(0, 10)}</span>
      </div>
      <div className="mem-actions">
        <button className="ghost" onClick=${() => startEdit(f)}>编辑</button>
        <button className="ghost" onClick=${() => del(f.id)}>删除</button>
      </div>
    </div>`;
  }

  return html`<div>
    <div className="pm-head">
      <input type="text" placeholder="检索长期记忆（自然语言）…" value=${query} onInput=${(e: Event) => setQuery((e.target as HTMLInputElement).value)} />
      <button className="ghost" onClick=${search}>检索</button>
      <button className="ghost" onClick=${load}>刷新</button>
    </div>
    <div className="pm-section">
      <div className="pm-title">新增 / 编辑记忆</div>
      <div className="form">
        <label>事实<input type="text" ref=${textRef} placeholder="如：用户要求所有 TS 文件用 camelCase" /></label>
        <label>主题<input type="text" ref=${topicRef} placeholder="编码规范 / 项目约定 / 环境" /></label>
        <label
          >重要度
          <select ref=${impRef}>
            <option value="1">1</option><option value="2">2</option><option value="3" selected>3</option>
            <option value="4">4</option><option value="5">5</option>
          </select>
        </label>
        <div className="row">
          <button className="send" onClick=${save}>${editingId ? '保存修改' : '保存'}</button>
          ${editingId ? html`<button className="ghost" onClick=${reset}>取消编辑</button>` : null}
        </div>
      </div>
    </div>
    <div className="pm-section">
      <div className="pm-title">已存记忆（${count}）</div>
      ${facts.length === 0
        ? html`<div className="empty">暂无记忆。上方填入事实后点「保存」，或在会话中由模型自动沉淀。</div>`
        : facts.map(row)}
    </div>
  </div>`;
}
