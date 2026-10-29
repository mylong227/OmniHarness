/**
 * 诊断面板（Web 交付项，2026-10-11）：把 **daemon 运行态**与**环境诊断报告**放在同一屏。
 *
 * ## 为什么两件事一屏
 *
 * 它们都是"本机现在到底怎么样"的**只读**视图，且都在同一刻被排查者需要（daemon 起着但 doctor 报
 * 沙箱未强制，就是典型组合）。合成一屏也避免把只读状态拆成两个几乎同形的入口。
 *
 * ## 三条 UI 纪律（都对应"别把没有读成正常"）
 *
 * 1. **未接线就直说**：`doctor.report` 返回 `ok:false`（serve 组合根未注入实现）时显示**未接线 + 原因**，
 *    **绝不**渲染成"体检通过"——空报告冒充健康是本仓反复记录的"看着绿"形态；
 * 2. **不合格项逐条列出**：`issues` 不得折叠成"有问题"，也不得只显示条数；
 * 3. **安全边界照实说**：`isolationLevel` 与 `kernelEnforced` 是**能力自述**（L2 ＝ 无内核强制），
 *    面板必须原样呈现，不许用"已启用沙箱"这种更乐观的措辞。
 *
 * @returns 诊断面板节点
 */
// 标准 React 项目写法：`import * as React from 'react'`（Vite 负责解析裸标识符）。
import * as React from 'react';
import { useApp } from '../../context.ts';
import { icon } from '../../models/Icon.ts';
import type { ReactElement } from 'react';
import type { DoctorReportLike } from '../../../types/models.ts';
import { t } from '../../i18n/i18n.ts';
// 面板级 antd 一律子路径导入（不走 'antd' 桶文件，理由见 vite.config.ts「分块改造」注释）。
import Descriptions from 'antd/es/descriptions';
import Table from 'antd/es/table';
import type { ColumnsType } from 'antd/es/table';

/** `daemon.status` 的返回形状。 */
interface DaemonStatus {
  readonly running: boolean;
  readonly pid?: number;
}

/** `doctor.report` 的返回形状（判别联合：未接线与成功必须可区分）。 */
type DoctorResponse = { readonly ok: true; readonly report: DoctorReportLike } | {
  readonly ok: false;
  readonly reason: string;
};

/**
 * doctor 报告正文（环境 / 安全档 / 不合格项）。
 *
 * 2026-10-29（W4）：键值区 → antd `Descriptions`，不合格项 → antd `Table`（逐条列出，err 行）。
 * 三条纪律的**文本原样保留**（判据按文本断言）。
 * @param props 报告。
 * @returns 报告节点。
 */
function DoctorReport({ report }: { report: DoctorReportLike }): ReactElement {
  const issueRows = report.issues.map((issue, index) => ({
    key: `${String(index)}-${issue}`,
    no: index + 1,
    issue,
  }));
  const issueColumns: ColumnsType<{ key: string; no: number; issue: string }> = [
    { title: '#', dataIndex: 'no', key: 'no', width: 48 },
    { title: t('问题'), dataIndex: 'issue', key: 'issue' },
  ];
  return (
    <div>
      <Descriptions
        className="diagnostics-desc"
        size="small"
        column={1}
        colon={false}
        items={[
          {
            key: 'node',
            label: t('Node / 配置'),
            children: `${report.nodeVersion} · ${t('配置')} ${
              report.config.valid
                ? t('合法')
                : t('非法（{reason}）', { reason: report.config.error ?? t('未知原因') })
            }`,
          },
          {
            key: 'security',
            label: t('安全档'),
            children: `${t('隔离档 {level}', { level: report.security.isolationLevel })}${
              report.security.kernelEnforced ? t('（内核强制）') : t('（**无内核强制**）')
            } · ${t('沙箱档')} ${report.security.sandboxProfile}`,
          },
          {
            key: 'basis',
            label: t('判定依据'),
            children: <span className="hint">{report.security.isolationBasis}</span>,
          },
          {
            key: 'guards',
            label: t('守卫'),
            children: (
              <span className="hint">
                {t('shell 出网受守卫约束：')}
                {report.security.shellEgressGuarded ? t('是') : t('否')} · {t('插件目录可读：')}
                {report.pluginsDirReadable ? t('是') : t('否')} · {t('权限清单可读：')}
                {report.permissionsManifestReadable ? t('是') : t('否')}
              </span>
            ),
          },
        ]}
      />
      {report.issues.length === 0 ? (
        <p>{t('无不合格项。')}</p>
      ) : (
        <div>
          <div className="detail-h">{t('不合格项（{count}）', { count: report.issues.length })}</div>
          <Table
            className="diagnostics-issues"
            size="small"
            bordered={false}
            pagination={false}
            columns={issueColumns}
            dataSource={issueRows}
            rowKey="key"
            rowClassName={() => 'row err'}
            scroll={{ x: 'max-content' }}
          />
        </div>
      )}
    </div>
  );
}

/** 诊断面板：daemon 运行态 + 环境诊断报告。 */
export function DiagnosticsTab(): ReactElement {
  const { api } = useApp();
  const [daemon, setDaemon] = React.useState<DaemonStatus | null>(null);
  const [doctor, setDoctor] = React.useState<DoctorResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState<boolean>(true);

  /** 拉取两项只读状态（任一失败都进 error 状态：UI 必须能显示"读不出来"）。 */
  const refresh = React.useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [d, r] = await Promise.all([
        api.daemonStatus(),
        api.doctorReport(),
      ]);
      setDaemon(d);
      setDoctor(r);
    } catch (e) {
      setError((e as Error).message);
      setDaemon(null);
      setDoctor(null);
    } finally {
      setLoading(false);
    }
  }, [api]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading) return <div className="diagnostics-tab">{t('正在体检…')}</div>;
  if (error !== null) {
    return (
      <div className="diagnostics-tab">
        <p className="err">{t('读取诊断数据失败：{msg}', { msg: error })}</p>
        <button type="button" onClick={() => void refresh()}>
          {t('重试')}
        </button>
      </div>
    );
  }

  return (
    <div className="diagnostics-tab">
      <div className="detail-section">
        <div className="detail-h">{t('后台服务（daemon）')}</div>
        {daemon === null || !daemon.running ? (
          // 未运行是**合法状态**，不是错误：如实说"未运行"，不显示成故障也不显示成正常。
          <p className="hint">{t('未运行（`omniharness daemon start` 可后台常驻）。')}</p>
        ) : (
          // `I18nParams` 的取值类型是 `string | number`，而 `daemon.pid` 是
          // `number | undefined`（类型上未运行时就可能缺失）⇒ 必须显式窄化（原为 TS2322）。
          // 用 `?? '—'` 而不是裸传：真走到这里时 daemon.running 为 true、pid 通常在，
          // 但给一个占位符总比渲染出字符串 "undefined" 好。
          <p>{t('运行中 · PID {pid}', { pid: daemon.pid ?? '—' })}</p>
        )}
      </div>

      <div className="detail-section">
        <div className="detail-h">{t('环境诊断（doctor）')}</div>
        {doctor !== null && !doctor.ok ? (
          // 纪律①：未接线必须直说——**不得**退化成"体检通过"。
          <p className="err">{t('未接线：{reason}', { reason: doctor.reason })}</p>
        ) : doctor !== null && doctor.ok ? (
          <DoctorReport report={doctor.report} />
        ) : (
          <p className="hint">{t('暂无诊断数据。')}</p>
        )}
        <button type="button" onClick={() => void refresh()}>
          {t('重新体检')}
        </button>
      </div>
      <div className="diagnostics-foot">
        {icon('ruler', { size: 14 })} {t('只读视图（不修改任何配置）')}
      </div>
    </div>
  );
}
