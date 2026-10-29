// 长期记忆管理：列出 / 检索 / 新增 / 编辑 / 删除事实记忆。reloadKey 变化（SSE memory.changed）时自动刷新。
//
// 函数组件范式：表单三个输入是非受控的（用 useRef 读写，与原实现一致）；
// 「挂载装载 + reloadKey 变化重载」合为一个依赖 reloadKey 的 effect（语义等价）；
// 星级渲染继续复用 ImportanceStars（零 React 依赖，可单测），行渲染下沉为模块级函数。

import * as React from 'react';
import { useApp } from '../../context.ts';
import { ImportanceStars } from '../../models/ImportanceStars.ts';
import { icon } from '../../models/Icon.ts';
import { emptyState } from '../../format.ts';
import type { MemoryFact } from '../../../types/models.ts';
import { t } from '../../i18n/i18n.ts';
// 面板级 antd 一律子路径导入（不走 'antd' 桶文件，理由见 vite.config.ts「分块改造」注释）。
import Table from 'antd/es/table';
import type { ColumnsType } from 'antd/es/table';
import Button from 'antd/es/button';

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
 * 已存记忆表（2026-10-29 W4：antd Table；表单区仍是非受控原生控件——编辑回填走 ref 直填，
 * antd Select 的受控语义与该模式相抵，保持原生待 §5.2 的表单专项）。
 * @param props 记忆数组与行动作。
 * @returns 表格节点。
 */
function MemoryTable(props: { facts: MemoryFact[] } & RowActions): ReactElement {
  const columns: ColumnsType<MemoryFact> = [
    { title: t('事实'), dataIndex: 'text', key: 'text' },
    {
      title: t('主题'),
      dataIndex: 'topic',
      key: 'topic',
      width: 120,
      render: (topic: string | undefined) =>
        topic ? <span className="badge">{topic}</span> : null,
    },
    {
      title: t('来源'),
      key: 'src',
      width: 80,
      render: (_, f) =>
        f.source === 'consolidated' ? (
          <span className="badge b-reasoning">{t('蒸馏')}</span>
        ) : (
          <span className="badge b-tool_call">{t('手动')}</span>
        ),
    },
    {
      title: t('重要度'),
      key: 'imp',
      width: 90,
      render: (_, f) => <span className="mem-imp">{ImportanceStars.render(f.importance || 0)}</span>,
    },
    {
      title: t('时间'),
      key: 'time',
      width: 100,
      render: (_, f) => <span className="mem-time">{(f.createdAt || '').slice(0, 10)}</span>,
    },
    {
      title: t('操作'),
      key: 'op',
      width: 130,
      render: (_, f) => (
        <>
          <Button size="small" onClick={() => props.onEdit(f)}>
            {t('编辑')}
          </Button>{' '}
          <Button size="small" onClick={() => props.onDelete(f.id)}>
            {t('删除')}
          </Button>
        </>
      ),
    },
  ];
  return (
    <Table<MemoryFact>
      className="memory-table"
      size="small"
      bordered={false}
      pagination={false}
      columns={columns}
      dataSource={[...props.facts]}
      rowKey="id"
      scroll={{ x: 'max-content' }}
    />
  );
}

/**
 * 长期记忆面板：检索、增删改事实记忆。
 * @param props 组件入参
 * @returns 记忆面板节点
 */
export function MemoryTab(props: MemoryTabProps): ReactElement {
  const { reloadKey } = props;
  const { api, toast, dialog, sessionTick } = useApp();
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
      // 服务端响应做形状归一：acts 缺失/非数组时按空列表处理。
      // 2026-10-19：桩数据/异常响应曾让 acts.map is not a function 触发错误边界、卸载整棵树。
      setCount(typeof r.count === 'number' ? r.count : 0);
      setFacts(Array.isArray(r.facts) ? r.facts : []);
    } catch (e) {
      toast(t('加载失败：{msg}', { msg: (e as Error).message }), 'err');
    }
  };

  // 挂载装载 + reloadKey 变化重载（deps 只有 reloadKey，load 只读 ref/闭包外的服务）。
  React.useEffect(() => {
    void load();
  }, [reloadKey, sessionTick]);

  /** 检索：空查询回落为全量列出。 */
  const search = async (): Promise<void> => {
    const q = query.trim();
    if (!q) {
      await load();
      return;
    }
    try {
      const r = await api.searchMemory(q, 20);
      setCount(typeof r.count === 'number' ? r.count : 0);
      setFacts(Array.isArray(r.results) ? r.results : []);
    } catch (e) {
      toast(t('检索失败：{msg}', { msg: (e as Error).message }), 'err');
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
      toast(t('请填写事实'), 'err');
      return;
    }
    const topic = topicRef.current ? topicRef.current.value.trim() || undefined : undefined;
    const importance = impRef.current ? parseInt(impRef.current.value, 10) || 3 : 3;
    try {
      if (editingId) await api.updateMemory({ id: editingId, text, topic, importance });
      else await api.addMemory({ text, topic, importance });
      toast(editingId ? t('已更新记忆') : t('已保存记忆'), 'ok');
      reset();
      await load();
    } catch (e) {
      toast(t('保存失败：{msg}', { msg: (e as Error).message }), 'err');
    }
  };

  /**
   * 删除（先经 DialogService 确认，决策不静默产生）。
   * @param id 记忆 id
   */
  const del = async (id: string): Promise<void> => {
    const ok = await dialog.confirm(t('确认删除这条记忆？'), {
      title: t('删除记忆'),
      confirmLabel: t('删除'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteMemory(id);
      toast(t('已删除'), 'ok');
      await load();
    } catch (e) {
      toast(t('删除失败：{msg}', { msg: (e as Error).message }), 'err');
    }
  };

  return (
    <div>
      <div className="pm-head">
        <input
          type="text"
          placeholder={t('检索长期记忆（自然语言）…')}
          value={query}
          onInput={(e: React.SyntheticEvent) => setQuery((e.target as HTMLInputElement).value)}
        />
        <button className="ghost" onClick={() => void search()}>
          {t('检索')}
        </button>
        <button className="ghost" onClick={() => void load()}>
          {t('刷新')}
        </button>
      </div>
      <div className="pm-section">
        <div className="pm-title">{t('新增 / 编辑记忆')}</div>
        <div className="form">
          <label>
            {t('事实')}
            <input
              type="text"
              ref={(el: HTMLInputElement | null) => {
                textRef.current = el;
              }}
              placeholder={t('如：用户要求所有 TS 文件用 camelCase')}
            />
          </label>
          <label>
            {t('主题')}
            <input
              type="text"
              ref={(el: HTMLInputElement | null) => {
                topicRef.current = el;
              }}
              placeholder={t('编码规范 / 项目约定 / 环境')}
            />
          </label>
          <label>
            {t('重要度')}
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
          <div className="pane-actions">
            <span className="flex-spacer"></span>
            {editingId ? (
              <button className="btn" onClick={reset}>
                {t('取消编辑')}
              </button>
            ) : null}
            <button className="btn primary" onClick={() => void save()}>
              {editingId ? t('保存修改') : t('保存')}
            </button>
          </div>
        </div>
      </div>
      <div className="pm-section">
        <div className="pm-title">{t('已存记忆（{count}）', { count })}</div>
        {facts.length === 0 ? (
          emptyState(
            icon('brain', { size: 20 }),
            t('暂无记忆'),
            t('上方填入事实后点「保存」，或在会话中由模型自动沉淀。'),
          )
        ) : (
          <MemoryTable facts={facts} onEdit={startEdit} onDelete={(id) => void del(id)} />
        )}
      </div>
    </div>
  );
}
