// 自动化任务：定时把提示词交给 Agent（服务端 30s 调度；任务触发即新建会话）。
import * as React from 'react';
import { useApp } from '../../context.ts';
import { t } from '../../i18n/i18n.ts';
// 面板级 antd 一律子路径导入（不走 'antd' 桶文件，理由见 vite.config.ts「分块改造」注释）。
import Table from 'antd/es/table';
import type { ColumnsType } from 'antd/es/table';
import Switch from 'antd/es/switch';
import Button from 'antd/es/button';

/** 自动化任务。 */
interface AutomationRow {
  id: string;
  name: string;
  prompt: string;
  intervalMinutes: number;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
}

/**
 * 新建自动化表单。
 * @param props 表单值与回调。
 * @returns 表单卡片。
 */
function AutomationForm(props: {
  name: string;
  prompt: string;
  minutes: string;
  busy: boolean;
  onName: (value: string) => void;
  onPrompt: (value: string) => void;
  onMinutes: (value: string) => void;
  onCreate: () => void;
}): React.ReactElement {
  return (
    <section className="act-card">
      <h3 className="act-title">{t('新建自动化')}</h3>
      <div className="auto-form">
        <input
          className="sp-input"
          value={props.name}
          onChange={(e) => props.onName(e.target.value)}
          placeholder={t('名称')}
          aria-label={t('自动化名称')}
        />
        <textarea
          className="sp-input auto-prompt"
          value={props.prompt}
          onChange={(e) => props.onPrompt(e.target.value)}
          placeholder={t('触发时发送给 Agent 的提示词')}
          aria-label={t('自动化提示词')}
        />
        <label className="act-status">
          {t('间隔（分钟，5–1440）')}
          <input
            className="sp-input"
            type="number"
            min={5}
            max={1440}
            value={props.minutes}
            onChange={(e) => props.onMinutes(e.target.value)}
            aria-label={t('自动化间隔分钟')}
          />
        </label>
        <button
          className="ghost"
          type="button"
          disabled={props.busy || props.name.trim() === '' || props.prompt.trim() === ''}
          onClick={props.onCreate}
        >
          {t('创建')}
        </button>
      </div>
    </section>
  );
}

/**
 * 自动化任务列表。
 * @param props 任务、错误、忙碌态与动作回调。
 * @returns 列表卡片。
 */
function AutomationList(props: {
  rows: AutomationRow[] | null;
  error: string;
  busy: boolean;
  onAct: (row: AutomationRow, action: 'toggle' | 'run' | 'delete') => void;
}): React.ReactElement {
  return (
    <section className="act-card">
      <h3 className="act-title">{t('任务')}</h3>
      {props.error !== '' ? (
        <p className="act-error" role="alert">{props.error}</p>
      ) : props.rows === null ? (
        <p className="act-muted">{t('读取中…')}</p>
      ) : props.rows.length === 0 ? (
        <p className="act-muted">{t('还没有自动化任务')}</p>
      ) : (
        <Table<AutomationRow>
          className="automations-table"
          size="small"
          bordered={false}
          pagination={false}
          columns={automationColumns(props.busy, props.onAct)}
          dataSource={[...props.rows]}
          rowKey="id"
          scroll={{ x: 'max-content' }}
        />
      )}
    </section>
  );
}


/** 任务表列定义（2026-10-30 W4：act-list → antd Table；启停用 antd Switch）。 */
function automationColumns(
  busy: boolean,
  onAct: (row: AutomationRow, action: 'toggle' | 'run' | 'delete') => void,
): ColumnsType<AutomationRow> {
  return [
    { title: t('名称'), dataIndex: 'name', key: 'name', render: (n: string) => <span className="auto-name">{n}</span> },
    { title: t('间隔'), key: 'interval', width: 110, render: (_, row) => t('每 {n} 分钟', { n: row.intervalMinutes }) },
    {
      title: t('状态'),
      key: 'enabled',
      width: 130,
      render: (_, row) => (
        <>
          <Switch
            size="small"
            checked={row.enabled}
            disabled={busy}
            aria-label={t('启停')}
            onChange={() => onAct(row, 'toggle')}
          />{' '}
          {row.enabled ? t('已启用') : t('已停用')}
        </>
      ),
    },
    {
      title: t('操作'),
      key: 'op',
      width: 170,
      render: (_, row) => (
        <>
          <Button size="small" disabled={busy} onClick={() => onAct(row, 'run')}>
            {t('立即运行')}
          </Button>{' '}
          <Button size="small" danger disabled={busy} onClick={() => onAct(row, 'delete')}>
            {t('删除')}
          </Button>
        </>
      ),
    },
  ];
}

/**
 * 自动化列表数据源（拉取 + 错误态）。
 * @param api RPC 客户端。
 * @returns 行数据、错误与刷新函数。
 */
function useAutomationRows(api: ReturnType<typeof useApp>['api']): {
  rows: AutomationRow[] | null;
  error: string;
  setError: (value: string) => void;
  refresh: () => Promise<void>;
} {
  const [rows, setRows] = React.useState<AutomationRow[] | null>(null);
  const [error, setError] = React.useState('');
  const refresh = React.useCallback(async (): Promise<void> => {
    try {
      const list = await api.listAutomations();
      setRows(Array.isArray(list) ? list : []);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api]);
  React.useEffect(() => {
    void refresh();
  }, [refresh]);
  return { rows, error, setError, refresh };
}

/** 自动化面板。 */
export function AutomationsTab(): React.ReactElement {
  const { api, toast, dialog } = useApp();
  const { rows, error, setError, refresh } = useAutomationRows(api);
  const [name, setName] = React.useState('');
  const [prompt, setPrompt] = React.useState('');
  const [minutes, setMinutes] = React.useState('30');
  const [busy, setBusy] = React.useState(false);

  /**
   * 新建任务。
   * @returns 无返回值。
   */
  const create = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await api.createAutomation({
        name,
        prompt,
        intervalMinutes: Number(minutes),
      });
      setName('');
      setPrompt('');
      await refresh();
      toast(t('自动化已创建'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 启停 / 立即运行 / 删除。
   * @param row 任务
   * @param action 动作
   * @returns 无返回值。
   */
  const act = async (row: AutomationRow, action: 'toggle' | 'run' | 'delete'): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      if (action === 'toggle') await api.setAutomationEnabled(row.id, !row.enabled);
      else if (action === 'run') await api.runAutomation(row.id);
      else if (await dialog.confirm(t('删除自动化「{name}」？', { name: row.name }))) {
        await api.deleteAutomation(row.id);
      }
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="act">
      <AutomationForm
        name={name}
        prompt={prompt}
        minutes={minutes}
        busy={busy}
        onName={setName}
        onPrompt={setPrompt}
        onMinutes={setMinutes}
        onCreate={() => void create()}
      />
      <AutomationList rows={rows} error={error} busy={busy} onAct={(row, action) => void act(row, action)} />
    </div>
  );
}
