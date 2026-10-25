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
  const pending = props.approval !== null || props.question !== null;
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

      {pending ? (
        <section className="act-card act-pending" aria-live="polite">
          <h3 className="act-title">{t('需要你处理')}</h3>
          {props.approval !== null ? (
            <p className="act-status">
              {t('工具调用等待审批：{tool}', {
                tool: props.approval.toolName ?? t('未知工具'),
              })}
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
      ) : null}

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

      <section className="act-card">
        <h3 className="act-title">{t('最近活动')}</h3>
        {recent.length === 0 ? (
          <p className="act-muted">{t('还没有事件')}</p>
        ) : (
          <ol className="act-list">
            {recent.map((event) => (
              <li key={event.id} className="act-item">
                <span className={'act-kind act-kind-' + event.type}>
                  {t(EVENT_LABEL[event.type] ?? event.type)}
                </span>
                <span className="act-text">{summarize(event)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
