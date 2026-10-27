/**
 * GUI 冒烟验收（2026-10-27，`OMNI_SMOKE=1` 时在真实桌面会话跑一轮可断言的检查）。
 *
 * ## 为什么需要它
 *
 * 桌面壳的「窗口 / CSP / 托盘 / 深链全链路验收」一直登记为**未做**——不是没人做，而是本机
 * 受限执行环境（无图形会话）里 Electron GUI 根本起不来（STATUS_BREAKPOINT），于是验收
 * 被无限顺延。本类把验收**变成可执行物**：用户在正常桌面会话里
 * `npm --prefix desktop run smoke` 一键跑完，退出码即结论（0 = 全过 / 1 = 有断言失败 /
 * 2 = 超时），明细 JSON 落盘可贴回 issue/看板。从此「验收没做」与「验收做了没证据」都不可辩。
 *
 * ## 零 electron 依赖（可在 node:test 里直跑）
 *
 * 本类只做**判定**：所有事实（窗口可见性 / DOM 挂载 / 桥版本 / 侧车状态）由调用方采集后
 * 以原始值传入。采集在 `main.ts` 的冒烟入口（`webContents.executeJavaScript` 等）完成。
 *
 * ## 断言面（致命 5 + 观测 3）
 *
 * 致命（任一失败 ⇒ pass=false）：
 * 1. `window.created`：主窗口存在且未销毁；
 * 2. `window.visible`：窗口可见（`--hidden` 启动时按预期隐藏判定，不算失败）；
 * 3. `harness.ready`：侧车在跑且端点可述；
 * 4. `ui.origin`：UI 确实加载自 harness 回环端点（而非启动页/错误页）；
 * 5. `ui.mounted`：React 根节点已挂载 + preload 桥 `window.omni.apiVersion === 3`。
 *
 * 观测（只记录不判死——托盘图标/系统通知/协议注册依赖环境，受限会话合法地可能缺失）：
 * `tray` / `notifications` / `protocol`。
 */

/** 一条冒烟检查结果。 */
export interface SmokeCheck {
  /** 检查名（稳定标识，不随文案变）。 */
  readonly name: string;
  /** 是否通过（观测项恒 true，只记录事实）。 */
  readonly ok: boolean;
  /** 事实/失败细节（人读）。 */
  readonly detail: string;
}

/** 冒烟报告。 */
export interface SmokeReport {
  /** 总判定：致命项全过为 true。 */
  readonly pass: boolean;
  /** 全部检查（致命 + 观测，按执行顺序）。 */
  readonly checks: readonly SmokeCheck[];
}

/** 冒烟判定入参（全部由调用方采集；本类不做任何 IO）。 */
export interface SmokeFacts {
  /** 主窗口存在且未销毁。 */
  readonly windowAlive: boolean;
  /** 窗口当前可见。 */
  readonly windowVisible: boolean;
  /** 启动是否带 `--hidden`（是则按「预期隐藏」判定可见性）。 */
  readonly hiddenLaunch: boolean;
  /** 侧车状态（`HarnessSupervisor.getState()`；null = 不可得）。 */
  readonly harnessState: string | null;
  /** 侧车端点（`host:port`；null = 未就绪）。 */
  readonly harnessEndpoint: string | null;
  /** UI 实际加载的 URL（null = 取不到）。 */
  readonly loadedUrl: string | null;
  /** 渲染层探针结果：React 根挂载 + 桥版本（null = executeJavaScript 失败）。 */
  readonly dom: { readonly root: boolean; readonly bridgeVersion: number } | null;
  /** 托盘是否创建成功。 */
  readonly trayCreated: boolean;
  /** 系统通知是否可用。 */
  readonly notificationsSupported: boolean;
  /** 深链协议是否已注册（开发态合法为 false）。 */
  readonly protocolRegistered: boolean;
}

/** GUI 冒烟判定（纯逻辑；无 electron 依赖）。 */
export class SmokeHarness {
  /**
   * 由事实判出报告。
   * @param facts 采集到的运行事实。
   * @returns 报告（pass + 逐条检查）。
   */
  public static judge(facts: SmokeFacts): SmokeReport {
    const checks: SmokeCheck[] = [];
    const fatal = (name: string, ok: boolean, detail: string): void => {
      checks.push({ name, ok, detail });
    };
    const info = (name: string, detail: string): void => {
      checks.push({ name, ok: true, detail });
    };

    fatal(
      'window.created',
      facts.windowAlive,
      facts.windowAlive ? '主窗口存在' : '主窗口缺失或已销毁',
    );
    const visibleOk = facts.windowAlive && (facts.hiddenLaunch || facts.windowVisible);
    fatal(
      'window.visible',
      visibleOk,
      facts.hiddenLaunch
        ? `--hidden 启动，预期隐藏（实际可见=${String(facts.windowVisible)}）`
        : `窗口可见=${String(facts.windowVisible)}`,
    );
    fatal(
      'harness.ready',
      facts.harnessState !== null && facts.harnessEndpoint !== null,
      facts.harnessEndpoint !== null
        ? `侧车 ${facts.harnessState ?? '?'} @ ${facts.harnessEndpoint}`
        : `侧车状态 ${facts.harnessState ?? 'null'}，无端点`,
    );
    const originOk =
      facts.loadedUrl !== null &&
      facts.harnessEndpoint !== null &&
      facts.loadedUrl.startsWith(`http://${facts.harnessEndpoint}/`);
    fatal(
      'ui.origin',
      originOk,
      `loadedUrl=${facts.loadedUrl ?? 'null'}（期望前缀 http://${facts.harnessEndpoint ?? '?'}/）`,
    );
    fatal(
      'ui.mounted',
      facts.dom !== null && facts.dom.root && facts.dom.bridgeVersion === 3,
      facts.dom === null
        ? '渲染层探针不可得（executeJavaScript 失败）'
        : `root=${String(facts.dom.root)} bridgeVersion=${String(facts.dom.bridgeVersion)}（期望 root=true bridgeVersion=3）`,
    );

    info('tray', facts.trayCreated ? '托盘已创建' : '托盘未创建（图标缺失/环境不支持——观测项）');
    info(
      'notifications',
      facts.notificationsSupported ? '系统通知可用' : '系统通知不可用（观测项）',
    );
    info(
      'protocol',
      facts.protocolRegistered ? '深链协议已注册' : '深链协议未注册（开发态/权限不足——观测项）',
    );

    return { pass: checks.every((check) => check.ok), checks };
  }

  /** 渲染层探针脚本（`webContents.executeJavaScript` 用；返回 root 挂载 + 桥版本）。 */
  public static readonly DOM_PROBE =
    "(function(){ return { root: document.querySelector('#root') !== null, bridgeVersion: (window.omni && window.omni.apiVersion) || 0 }; })()";
}
