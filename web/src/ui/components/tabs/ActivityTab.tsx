// 活动面板：把「当前在跑什么 / 待处理审批 / 变更摘要 / 最近事件」收进一屏。
//
// 之前这些信息分散在中栏状态、工具面板、变更面板与审批弹窗里；Codex 式桌面工作台需要一个
// 一眼能回答「现在卡在哪、下一步点哪」的入口。本面板只做**聚合视图**，不复制业务逻辑：
// 审批/提问仍由 ApprovalModal / QuestionCard 处理，变更仍由 ChangesTab 负责写操作。
import * as React from 'react';
import { useApp } from '../../context.ts';
import type { ApprovalRequest, QuestionRequest, ThreadEvent } from '../../../types/models.ts';
import type { ToolResultView } from '../../shared.ts';
import { t } from '../../i18n/i18n.ts';
// 面板级 antd 一律子路径导入（不走 'antd' 桶文件，理由见 vite.config.ts「分块改造」注释）。
import Table from 'antd/es/table';
import type { ColumnsType } from 'antd/es/table';

/** 活动面板入参。 */
export interface ActivityTabProps {
  /** 当前会话事件。 */
  events: ThreadEvent[];
  /** 工具结果表。 */
  toolResults: Record<string, ToolResultView>;
  /** 是否有回合在跑。 */
  busy: boolean;
  /** 正在执行的工具名（null 表示没有）。 */
  activeTool: string | null;
  /** 待审批请求。 */
  approval: ApprovalRequest | null;
  /** 待作答提问。 */
  question: QuestionRequest | null;
  /** 打开右栏其他面板。 */
  onOpenPane: (key: string) => void;
}

/** 变更摘要最小形状（与 ChangesTab 的 changes.list 返回一致）。 */
interface ChangesSummary {
  source: string;
  branch?: string;
  files?: readonly { path: string; status: string; additions?: number; deletions?: number }[];
}

/** 事件类型的中文标签（t() 的键是中文原文）。 */
const EVENT_LABEL: Record<string, string> = {
  user: '用户',
  assistant: '助手',
  reasoning: '推理',
  tool_call: '工具调用',
  tool_result: '工具结果',
  turn_diff: '变更',
  system: '系统',
  plan: '计划',
  question: '提问',
  todo: '待办',
  model: '模型',
  session_meta: '会话',
};

/**
 * 事件的一句话摘要（不渲染 Markdown，活动流只做快速扫读）。
 * @param event 事件
 * @returns 摘要
 */
function summarize(event: ThreadEvent): string {
  const payload = event.payload ?? {};
  const text = typeof payload['content'] === 'string' ? payload['content'] : '';
  switch (event.type) {
    case 'user':
      return text === '' ? t('用户消息') : text;
    case 'assistant':
      return text === '' ? t('助手回复') : text;
    case 'reasoning':
      return text === '' ? t('推理') : text;
    case 'tool_call':
      return [payload['name'], payload['command']].filter((v) => typeof v === 'string').join(' · ');
    case 'tool_result':
      return payload['ok'] === true ? t('工具完成') : t('工具失败');
    case 'turn_diff':
      return t('本轮变更');
    case 'system':
      return text === '' ? t('系统事件') : text;
    default:
      return event.type;
  }
}

/**
 * 待处理事项（审批 / 提问）。
 * @param props 待审批与待作答请求。
 * @returns 卡片节点；无待办时 null。
 */
function PendingActivity(props: {
  approval: ApprovalRequest | null;
  question: QuestionRequest | null;
}): React.ReactElement | null {
  if (props.approval === null && props.question === null) return null;
  return (
    <section className="act-card act-pending" aria-live="polite">
      <h3 className="act-title">{t('需要你处理')}</h3>
      {props.approval !== null ? (
        <p className="act-status">
          {t('工具调用等待审批：{tool}', { tool: props.approval.toolName ?? t('未知工具') })}
        </p>
      ) : null}
      {props.question !== null ? (
        <p className="act-status">
          {t('Agent 正在等待回答：{question}', {
            question: props.question.questions[0]?.question ?? t('问题'),
          })}
        </p>
      ) : null}
    </section>
  );
}

/** 最近活动表的行（与事件一一对应）。 */
interface ActivityRow {
  readonly key: string;
  readonly event: ThreadEvent;
}

/**
 * 最近活动列表（2026-10-29 W4：antd Table；`act-kind-*` 配色类保留在类型徽标上）。
 * @param props 最近事件。
 * @returns 卡片节点。
 */
function RecentActivity(props: { events: ThreadEvent[] }): React.ReactElement {
  const rows: ActivityRow[] = props.events.map((event) => ({ key: event.id, event }));
  const columns: ColumnsType<ActivityRow> = [
    {
      title: t('类型'),
      key: 'kind',
      width: 110,
      render: (_, row) => (
        <span className={'act-kind act-kind-' + row.event.type}>
          {t(EVENT_LABEL[row.event.type] ?? row.event.type)}
        </span>
      ),
    },
    { title: t('摘要'), key: 'text', render: (_, row) => summarize(row.event) },
  ];
  return (
    <section className="act-card">
      <h3 className="act-title">{t('最近活动')}</h3>
      {props.events.length === 0 ? (
        <p className="act-muted">{t('还没有事件')}</p>
      ) : (
        <Table<ActivityRow>
          className="activity-table"
          size="small"
          bordered={false}
          pagination={false}
          columns={columns}
          dataSource={rows}
          rowKey="key"
          scroll={{ x: 'max-content' }}
        />
      )}
    </section>
  );
}

/** 活动面板。 */
export function ActivityTab(props: ActivityTabProps): React.ReactElement {
  const { api, sessionTick } = useApp();
  const [changes, setChanges] = React.useState<ChangesSummary | null>(null);
  const [changesError, setChangesError] = React.useState('');

  React.useEffect(() => {
    let alive = true;
    api
      .listChanges()
      .then((next: ChangesSummary) => {
        if (alive) {
          setChanges(next);
          setChangesError('');
        }
      })
      .catch((cause: unknown) => {
        if (alive) setChangesError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      alive = false;
    };
  }, [api, sessionTick]);

  const recent = props.events.slice(-12).reverse();
  const changedFiles = changes?.files?.length ?? 0;
  const added = (changes?.files ?? []).reduce((n, f) => n + (f.additions ?? 0), 0);
  const removed = (changes?.files ?? []).reduce((n, f) => n + (f.deletions ?? 0), 0);

  return (
    <div className="act">
      <section className="act-card">
        <h3 className="act-title">{t('当前活动')}</h3>
        <p className="act-status" role="status">
          {props.busy
            ? props.activeTool === null
              ? t('任务进行中')
              : t('正在执行 {tool}', { tool: props.activeTool })
            : t('空闲')}
        </p>
        <div className="act-actions">
          <button className="ghost" type="button" onClick={() => props.onOpenPane('trace')}>
            {t('查看 Trace')}
          </button>
          <button className="ghost" type="button" onClick={() => props.onOpenPane('tools')}>
            {t('查看工具')}
          </button>
        </div>
      </section>

      <PendingActivity approval={props.approval} question={props.question} />

      <section className="act-card">
        <h3 className="act-title">{t('变更摘要')}</h3>
        {changesError !== '' ? (
          <p className="act-error" role="alert">
            {t('读取变更失败：{msg}', { msg: changesError })}
          </p>
        ) : (
          <p className="act-status">
            {changedFiles === 0
              ? t('没有未提交的变更')
              : t('{n} 个文件 · +{added} / -{removed}', {
                  n: changedFiles,
                  added,
                  removed,
                })}
          </p>
        )}
        <div className="act-actions">
          <button className="ghost" type="button" onClick={() => props.onOpenPane('changes')}>
            {t('打开变更面板')}
          </button>
        </div>
      </section>

      <RecentActivity events={recent} />
    </div>
  );
}
