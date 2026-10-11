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
// 零打包器：React 由 deps.js 从 UMD 全局取（**不得** `import ... from 'react'`——浏览器无法解析该裸标识符）。
import { React } from '../../deps.js';
import { useApp } from '../../context.js';
import { icon } from '../../models/Icon.js';
import type { ReactElement } from 'react';
import type { DoctorReportLike } from '../../../types/models.js';

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

  if (loading) return <div className="diagnostics-tab">正在体检…</div>;
  if (error !== null) {
    return (
      <div className="diagnostics-tab">
        <p className="err">读取诊断数据失败：{error}</p>
        <button type="button" onClick={() => void refresh()}>
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="diagnostics-tab">
      <div className="detail-section">
        <div className="detail-h">后台服务（daemon）</div>
        {daemon === null || !daemon.running ? (
          // 未运行是**合法状态**，不是错误：如实说"未运行"，不显示成故障也不显示成正常。
          <p className="hint">未运行（`omniharness daemon start` 可后台常驻）。</p>
        ) : (
          <p>运行中 · PID {daemon.pid}</p>
        )}
      </div>

      <div className="detail-section">
        <div className="detail-h">环境诊断（doctor）</div>
        {doctor !== null && !doctor.ok ? (
          // 纪律①：未接线必须直说——**不得**退化成"体检通过"。
          <p className="err">未接线：{doctor.reason}</p>
        ) : doctor !== null && doctor.ok ? (
          <div>
            <p>
              Node {doctor.report.nodeVersion} · 配置{' '}
              {doctor.report.config.valid ? '合法' : `非法（${doctor.report.config.error ?? '未知原因'}）`}
            </p>
            <p>
              隔离档 {doctor.report.security.isolationLevel}
              {doctor.report.security.kernelEnforced ? '（内核强制）' : '（**无内核强制**）'} · 沙箱档{' '}
              {doctor.report.security.sandboxProfile}
            </p>
            <p className="hint">{doctor.report.security.isolationBasis}</p>
            <p className="hint">
              shell 出网受守卫约束：{doctor.report.security.shellEgressGuarded ? '是' : '否'} ·
              插件目录可读：{doctor.report.pluginsDirReadable ? '是' : '否'} · 权限清单可读：
              {doctor.report.permissionsManifestReadable ? '是' : '否'}
            </p>
            {doctor.report.issues.length === 0 ? (
              <p>无不合格项。</p>
            ) : (
              <div>
                {/* 纪律②：逐条列出，不折叠成"有问题"。 */}
                <div className="detail-h">不合格项（{doctor.report.issues.length}）</div>
                <ul>
                  {doctor.report.issues.map((issue, index) => (
                    <li key={`${String(index)}-${issue}`} className="err">
                      {issue}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <p className="hint">暂无诊断数据。</p>
        )}
        <button type="button" onClick={() => void refresh()}>
          重新体检
        </button>
      </div>
      <div className="diagnostics-foot">{icon('ruler', { size: 14 })} 只读视图（不修改任何配置）</div>
    </div>
  );
}
