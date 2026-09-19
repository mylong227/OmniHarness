// 长期记忆管理：列出 / 检索 / 新增 / 编辑 / 删除事实记忆。reloadKey 变化（SSE memory.changed）时自动刷新。
//
// 函数组件范式：表单三个输入是非受控的（用 useRef 读写，与原实现一致）；
// 「挂载装载 + reloadKey 变化重载」合为一个依赖 reloadKey 的 effect（语义等价）；
// 星级渲染继续复用 ImportanceStars（零 React 依赖，可单测），行渲染下沉为模块级函数。

import { React } from '../../deps.js';
import { useApp } from '../../context.js';
import { ImportanceStars } from '../../models/ImportanceStars.js';
import type { MemoryFact } from '../../../types/models.js';

/** MemoryTab 组件的入参。 */
export interface MemoryTabProps {
  /** 外部重载信号（SSE memory.changed 时自增，触发重新拉取）。 */
  reloadKey: number;
}

/** 行渲染所需的回调。 */
interface RowActions {
  /** 进入编辑态并回填表单。 */
  onEdit: (f: MemoryFact) => void;
  /** 删除该条记忆。 */
  onDelete: (id: string) => void;
}

/**
 * 渲染单条记忆行：正文 + 主题 / 来源 / 星级 / 时间 + 操作。
 * @param f 记忆条目
 * @param actions 编辑 / 删除回调
 * @returns 记忆行节点
 */
function renderRow(f: MemoryFact, actions: RowActions): ReactElement {
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
        <button className="ghost" onClick={() => actions.onEdit(f)}>
          编辑
        </button>
        <button className="ghost" onClick={() => actions.onDelete(f.id)}>
          删除
        </button>
      </div>
    </div>
  );
}

/**
 * 长期记忆面板：检索、增删改事实记忆。
 * @param props 组件入参
 * @returns 记忆面板节点
 */
export function MemoryTab(props: MemoryTabProps): ReactElement {
  const { reloadKey } = props;
  const { api, toast, dialog } = useApp();
  const [facts, setFacts] = React.useState<MemoryFact[]>([]);
  const [count, setCount] = React.useState<number>(0);
  const [query, setQuery] = React.useState<string>('');
  /** 正在编辑的记忆 id；null 表示新增态。 */
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const textRef = React.useRef<HTMLInputElement | null>(null);
  const topicRef = React.useRef<HTMLInputElement | null>(null);
  const impRef = React.useRef<HTMLSelectElement | null>(null);

  /** 列出全部记忆。 */
  const load = async (): Promise<void> => {
    try {
      const r = await api.listMemory();
      setCount(r.count);
      setFacts(r.facts);
    } catch (e) {
      toast('加载失败：' + (e as Error).message, 'err');
    }
  };

  // 挂载装载 + reloadKey 变化重载（deps 只有 reloadKey，load 只读 ref/闭包外的服务）。
  React.useEffect(() => {
    void load();
  }, [reloadKey]);

  /** 检索：空查询回落为全量列出。 */
  const search = async (): Promise<void> => {
    const q = query.trim();
    if (!q) {
      await load();
      return;
    }
    try {
      const r = await api.searchMemory(q, 20);
      setCount(r.count);
      setFacts(r.results);
    } catch (e) {
      toast('检索失败：' + (e as Error).message, 'err');
    }
  };

  /**
   * 进入编辑态：把该条记忆回填到表单。
   * @param f 待编辑记忆
   */
  const startEdit = (f: MemoryFact): void => {
    setEditingId(f.id);
    if (textRef.current) textRef.current.value = f.text;
    if (topicRef.current) topicRef.current.value = f.topic || '';
    if (impRef.current) impRef.current.value = String(f.importance || 3);
  };

  /** 复位表单到新增态。 */
  const reset = (): void => {
    setEditingId(null);
    if (textRef.current) textRef.current.value = '';
    if (topicRef.current) topicRef.current.value = '';
    if (impRef.current) impRef.current.value = '3';
  };

  /** 保存：按 editingId 决定新增或更新。 */
  const save = async (): Promise<void> => {
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
      await load();
    } catch (e) {
      toast('保存失败：' + (e as Error).message, 'err');
    }
  };

  /**
   * 删除（先经 DialogService 确认，决策不静默产生）。
   * @param id 记忆 id
   */
  const del = async (id: string): Promise<void> => {
    const ok = await dialog.confirm('确认删除这条记忆？', {
      title: '删除记忆',
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteMemory(id);
      toast('已删除', 'ok');
      await load();
    } catch (e) {
      toast('删除失败：' + (e as Error).message, 'err');
    }
  };

  return (
    <div>
      <div className="pm-head">
        <input
          type="text"
          placeholder="检索长期记忆（自然语言）…"
          value={query}
          onInput={(e: Event) => setQuery((e.target as HTMLInputElement).value)}
        />
        <button className="ghost" onClick={() => void search()}>
          检索
        </button>
        <button className="ghost" onClick={() => void load()}>
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
                textRef.current = el;
              }}
              placeholder="如：用户要求所有 TS 文件用 camelCase"
            />
          </label>
          <label>
            主题
            <input
              type="text"
              ref={(el: HTMLInputElement | null) => {
                topicRef.current = el;
              }}
              placeholder="编码规范 / 项目约定 / 环境"
            />
          </label>
          <label>
            重要度
            <select
              ref={(el: HTMLSelectElement | null) => {
                impRef.current = el;
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
            <button className="send" onClick={() => void save()}>
              {editingId ? '保存修改' : '保存'}
            </button>
            {editingId ? (
              <button className="ghost" onClick={reset}>
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
          facts.map((f) =>
            renderRow(f, { onEdit: startEdit, onDelete: (id) => void del(id) }),
          )
        )}
      </div>
    </div>
  );
}
