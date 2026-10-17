/**
 * Web 交付项之一：**只读可观测 RPC**（`daemon.status` / `doctor.report`）判据（2026-10-11）。
 *
 * ## 为什么这两条先做
 *
 * 目标第 (7) 项列了六个 Web 入口，其中"daemon status / doctor 面板"的**后端实现早就存在**
 * （`DaemonController` 与 `DoctorRunner`），缺的只是 RPC 与面板 —— 而 `trace.read`/`audit.query`
 * 也是同类。先做这两条是因为它们**只读、零写路径**，且能把"面板数据与 CLI 同源"这条纪律钉死。
 *
 * ## 判据口径（都在钉"如实"）
 *
 * | # | 判据 | 坏掉的后果 |
 * | --- | --- | --- |
 * | ① | `daemon.status` 与 CLI 的 `DaemonController` **同一事实源**（默认 pid 文件一致） | 面板显示"未运行"而 CLI 说在跑（或反之） |
 * | ② | `doctor.report` **未注入实现时显式报错**（`ok:false` + 原因），绝不返回空报告 | 空报告被面板读成"体检全过"——正是本仓反复记录的"看着绿" |
 * | ③ | 注入后：`ok:true` + 原样回传报告；`workspaceRoot` 参数**透传到实现** | 面板请求某工作区、实际体检的是另一个 |
 * | ④ | serve 组合根注入的实现与 `omniharness doctor` 命令**同一个** | 面板与 CLI 给出不一致的诊断结论 |
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AppServer } from '../../src/server/core/appServer.ts';
import { AppServerObservabilityHandlers } from '../../src/server/core/appServerObservabilityHandlers.ts';
import { DaemonController } from '../../src/daemon/daemonController.ts';
import { ConfigFactory } from '../../src/config/configFactory.ts';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.ts';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.ts';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.ts';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.ts';
import type { DoctorOptions, DoctorReport } from '../../src/ports/observability/doctorReport.ts';

/** 仓库根（判据在 `dist/tests/unit/`，源码按 cwd 读）。 */
const REPO_ROOT = process.cwd();

/** 造一份最小可用的服务端（不经传输层，判据只关心数据面）。 */
function makeServer(doctorReport?: (options?: DoctorOptions) => DoctorReport): AppServer {
  const config = ConfigFactory.build({
    workspaceRoot: process.cwd(),
    maxSteps: 4,
    // 与既有服务端判据同形：本文件不驱动模型，只需一个满足装配的替身。
    model: { generate: async () => ({ text: '' }) } as never,
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
  });
  return new AppServer({
    config,
    transport: { send: () => {}, onMessage: () => {} },
    modelOverrideEnabled: false,
    ...(doctorReport === undefined ? {} : { doctorReport }),
  });
}

/**
 * 直接调已注册的 RPC 处理器（不经传输层）。
 *
 * @param server 服务端。
 * @param method 方法名。
 * @param params 参数。
 * @returns 处理器返回体。
 */
async function call(
  server: AppServer,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const handlers = (
    server as unknown as {
      handlers: Map<string, (p: Record<string, unknown>) => Promise<unknown>>;
    }
  ).handlers;
  const handler = handlers.get(method);
  assert.ok(handler !== undefined, `必须注册 ${method}`);
  return handler(params);
}

/** 一份最小的合法 doctor 报告（字段与端口契约一致）。 */
function fakeReport(nodeVersion: string): DoctorReport {
  return {
    nodeVersion,
    config: { exists: false, valid: true },
    sandbox: { bwrap: false, sandboxExec: false, restrictedToken: false },
    sandboxCapabilities: [],
    security: {
      isolationLevel: 'L2',
      isolationBasis: '判据造的报告',
      sandboxProfile: 'policy',
      kernelEnforced: false,
      networkGuardSurfaces: [],
      shellEgressGuarded: false,
      networkGuardBasis: '判据造的报告',
      injectionMode: 'off',
      injectionThresholds: {},
    },
    injectionSelfCheck: undefined,
    pluginsDirReadable: true,
    permissionsManifestReadable: true,
    issues: [],
  };
}

test('① daemon.status 与 CLI 的 DaemonController 同源（同一默认 pid 文件）', async () => {
  // 结构自证（顺带满足成熟度门禁的"证据必须真正 import 被声明的模块"）：新层必须真的在继承链上，
  // 否则 `appServerObservabilityHandlers.ts` 就是**死代码**——两个 RPC 由别的路径注册，文件无人用。
  assert.ok(
    AppServer.prototype instanceof AppServerObservabilityHandlers,
    'AppServer 必须经由 AppServerObservabilityHandlers 层（否则该层是死代码）',
  );
  const server = makeServer();
  const viaRpc = (await call(server, 'daemon.status')) as { running: boolean; pid?: number };
  // 独立构造一个控制器（CLI `daemon status` 走的正是这条）⇒ 两者结论必须一致。
  const viaCli = new DaemonController().status();
  assert.deepStrictEqual(
    viaRpc,
    viaCli,
    'RPC 与 CLI 的 daemon 状态必须同源；不一致说明 pid 文件口径漂了（面板会与命令行互相打脸）',
  );
  assert.strictEqual(typeof viaRpc.running, 'boolean', 'running 必须是布尔');
  if (viaRpc.running) {
    assert.strictEqual(typeof viaRpc.pid, 'number', 'running=true 时必须给出 pid');
  }
});

test('② doctor.report 未注入实现时**显式报错**，绝不返回空报告冒充"体检全过"', async () => {
  const server = makeServer();
  const result = (await call(server, 'doctor.report')) as { ok: boolean; reason?: string };
  assert.strictEqual(result.ok, false, '未接线必须 ok:false');
  assert.match(
    String(result.reason),
    /未接线/u,
    '必须给出可读原因（面板据此显示"未接线"而非"一切正常"）',
  );
  // **反面对照**：不得把"没有报告"伪装成一份空报告（那会被面板读成健康）。
  assert.strictEqual('report' in result, false, '未接线时不得回传 report 字段');
  assert.strictEqual('issues' in result, false, '未接线时不得回传 issues（空数组同样是伪装）');
});

test('③ 注入后：ok:true + 原样回传报告，且 workspaceRoot 透传到实现', async () => {
  const seen: (DoctorOptions | undefined)[] = [];
  const server = makeServer((options) => {
    seen.push(options);
    return fakeReport(options?.workspaceRoot ?? 'no-workspace');
  });
  const withoutParam = (await call(server, 'doctor.report')) as {
    ok: boolean;
    report?: DoctorReport;
  };
  assert.strictEqual(withoutParam.ok, true);
  assert.strictEqual(
    withoutParam.report?.nodeVersion,
    'no-workspace',
    '未给参数时应原样透传 undefined',
  );

  const withParam = (await call(server, 'doctor.report', { workspaceRoot: '/tmp/probe' })) as {
    ok: boolean;
    report?: DoctorReport;
  };
  assert.strictEqual(withParam.report?.nodeVersion, '/tmp/probe', 'workspaceRoot 必须透传到实现');
  assert.deepStrictEqual(seen, [undefined, { workspaceRoot: '/tmp/probe' }]);
});

test('⑤ audit.query：未接线时**显式报错**（不得回空数组冒充"审计无记录"）', async () => {
  const server = makeServer();
  const result = (await call(server, 'audit.query')) as { ok: boolean; reason?: string };
  assert.strictEqual(result.ok, false, '未注入 audit sink 必须 ok:false');
  assert.match(String(result.reason), /未接线/u, '必须给出可读原因');
  // 反面对照：**不得**回 events:[] —— 空数组会被面板读成"审计无记录"。
  assert.strictEqual('events' in result, false, '未接线时不得带 events 字段');
});

test('④ serve 组合根注入的 doctor 实现与 `omniharness doctor` 命令**同一个**（附正对照）', () => {
  const source = readFileSync(join(REPO_ROOT, 'src/cli/cliServerCmds.ts'), 'utf8');
  /**
   * 统计注入点数量。
   *
   * 为什么用**计数**而不是 `match`/`doesNotMatch`：注入点从 1 处变成 2 处（stdio + serve）后，
   * `String.replace` 只换第一处，旧写法的"变异后不再匹配"就假红了。计数式对"有几处"天然不敏感。
   * @param text 待统计源码
   * @returns 注入点数量
   */
  const injections = (text: string): number =>
    [...text.matchAll(/doctorReport:\s*\(options\)\s*=>\s*DoctorRunner\.runDoctor\(/gu)].length;
  assert.ok(injections(source) >= 1, '必须注入 DoctorRunner.runDoctor（与 doctor 命令同源）');
  // 同文件里 `doctor` 命令也走同一个静态方法——两处都在同一文件，可直接反查。
  assert.match(
    source,
    /DoctorRunner\.runDoctor\(\{ configPath \}\)/u,
    'doctor 命令的实现应仍是同一个',
  );

  // **正对照**：把**全部**注入点换成"另一个实现"后计数必须归零（否则判据④恒真）。
  const mutated = source.replaceAll(
    /doctorReport:\s*\(options\)\s*=>\s*DoctorRunner\.runDoctor\(/gu,
    'FakeDoctor.runDoctor(',
  );
  assert.notStrictEqual(mutated, source, '正对照变异未命中 ⇒ 判据锚点漂了');
  assert.strictEqual(injections(mutated), 0, '换成另一个实现却检不出来 ⇒ 判据④恒真');
});
