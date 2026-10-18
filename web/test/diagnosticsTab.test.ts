/**
 * 诊断面板判据（Web 交付项：`daemon status` + `doctor 面板`，2026-10-11）。
 *
 * ## 判据要钉死什么（全部围绕"别把没有读成正常"）
 *
 * 1. **两个 RPC 名**：`ApiClient` 必须调 `daemon.status` 与 `doctor.report`（名字写错 ⇒ 面板永远空着而无人知）；
 * 2. **未接线直说**：`doctor.report` 返回 `ok:false` ⇒ 面板显示"未接线"，
 *    **不得**出现"无不合格项/体检通过"这类乐观文案——空报告冒充健康是本仓反复记录的形态；
 * 3. **不合格项逐条可见**：`issues` 有几条就渲染几条（不得折叠成一句"有问题"）；
 * 4. **安全边界照实说**：`kernelEnforced:false` 时必须出现"无内核强制"字样
 *    （不许只说"隔离档 L2"让人以为已强制），且 `true` 时**不得**再说"无内核强制"（正对照）；
 * 5. **入口已注册**：`PANELS` 含 `diagnostics`、`Router.parseHash` 认可 `#pane=diagnostics`
 *    （漏注册会让该入口静默落回默认面板）。
 *
 * 渲染口径与仓内其他 tab 判据一致：桩版 `useEffect` 是占位槽（零 DOM 无真实提交阶段），
 * 故用**槽位预设**驱动"已加载完成"的状态。
 */

// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderFacadeAsync } from './rtlHarness.ts';
import { allText as facadeAllText } from './domFacade.ts';


const { DiagnosticsTab } = await import('../src/ui/components/tabs/DiagnosticsTab.tsx');
const { PANELS } = await import('../src/ui/models/PanelRegistry.ts');
const { parseHash } = await import('../src/core/Router.ts');

/**
 * 渲染一次组件（函数组件：换组件即清槽位）。
 * @param seed hook 槽位预设值
 * @returns vnode 树
 */
function report(over = {}) {
  return {
    nodeVersion: 'v22.20.0',
    config: { exists: true, valid: true },
    security: {
      isolationLevel: 'L2',
      isolationBasis: '本机无内核强制后端可达',
      sandboxProfile: 'policy',
      kernelEnforced: false,
      shellEgressGuarded: false,
    },
    pluginsDirReadable: true,
    permissionsManifestReadable: true,
    issues: [],
    ...over,
  };
}

/**
 * 渲染诊断面板并等一次取数落地。
 * @param responses 按 api 方法名给返回值（`daemonStatus` / `doctorReport`）
 * @returns 外观节点
 */
async function renderSeeded(responses: Record<string, unknown>) {
  const ui = await renderFacadeAsync(DiagnosticsTab, { props: {}, responses });
  return ui.node;
}

/**
 * 以给定状态渲染并取文本。
 * @param daemon daemon 状态（形状由被测组件的 useState 槽位决定）
 * @param doctor doctor 响应
 * @returns 面板文本
 */
async function textWith(daemon: unknown, doctor: unknown) {
  const ui = await renderSeeded({ daemonStatus: daemon, doctorReport: doctor });
  return facadeAllText(ui);
}

test('① ApiClient 的方法名与 RPC 名一致（改错名字 ⇒ 面板永远空着而无人知）', async () => {
  const source = readFileSync('web/src/core/ApiClient.ts', 'utf8');
  assert.match(source, /this\.rpc\('daemon\.status'/u, 'daemonStatus 必须调 daemon.status');
  assert.match(source, /this\.rpc\('doctor\.report'/u, 'doctorReport 必须调 doctor.report');
  // 正对照：把方法名换掉必须被本检查的谓词识别（防"只要文件里有这串就算过"）。
  const mutated = source.replace("this.rpc('doctor.report'", "this.rpc('doctor.reportTypo'");
  assert.notStrictEqual(mutated, source, '正对照变异未命中 ⇒ 判据锚点漂了');
  assert.doesNotMatch(mutated, /this\.rpc\('doctor\.report'/u, '改错 RPC 名却检不出来 ⇒ 判据①恒真');
});

test('② 未接线直说：ok:false ⇒ 显示"未接线"且**不得**出现乐观文案', async () => {
  const text = await textWith({ running: false }, {
    ok: false,
    reason: 'doctor 未接线（serve 组合根未注入 doctorReport）',
  });
  assert.match(text, /未接线/u, '必须显示"未接线"');
  assert.match(text, /serve 组合根未注入/u, '必须带出服务端给的原因');
  assert.doesNotMatch(text, /无不合格项/u, '未接线时不得出现"无不合格项"（那是把没有读成正常）');
  assert.doesNotMatch(text, /体检通过/u, '未接线时不得出现"体检通过"');
  // 未运行时也必须如实说"未运行"，且这不该被当作错误。
  assert.match(text, /未运行/u);
});

test('③ 不合格项逐条可见（不折叠成一句"有问题"），运行中显示 PID', async () => {
  const issues = ['配置文件 JSON 非法', '插件目录不可读', '网络守卫未覆盖 shell'];
  const text = await textWith({ running: true, pid: 4321 }, { ok: true, report: report({ issues }) });
  assert.match(text, /PID 4321/u, '运行中必须显示 PID');
  for (const issue of issues) {
    assert.ok(text.includes(issue), `不合格项必须逐条出现：${issue}`);
  }
  assert.doesNotMatch(text, /无不合格项/u, '有不合格项时不得同时出现"无不合格项"');
  assert.match(text, /不合格项（3）/u, '应给出条数');
});

test('④ 安全边界照实说：无内核强制必须写出来（附 true 的正对照）', async () => {
  const kernelOff = await textWith({ running: false }, { ok: true, report: report() });
  assert.match(kernelOff, /L2/u, '隔离档必须显示');
  assert.match(kernelOff, /无内核强制/u, 'kernelEnforced=false 时必须出现"无内核强制"');

  const kernelOn = await textWith({ running: false }, {
    ok: true,
    report: report({
      security: {
        isolationLevel: 'L3',
        isolationBasis: 'landlock 可达',
        sandboxProfile: 'restricted',
        kernelEnforced: true,
        shellEgressGuarded: true,
      },
    }),
  });
  assert.match(kernelOn, /内核强制/u);
  assert.doesNotMatch(kernelOn, /无内核强制/u, '正对照：已强制时不得说"无内核强制"');
});

test('⑤ 无不合格项时才显示"无不合格项"（正对照，防判据②是恒真）', async () => {
  const text = await textWith({ running: false }, { ok: true, report: report({ issues: [] }) });
  assert.match(text, /无不合格项/u, '真的没问题时必须如实说没问题（否则②的"未接线不显示"就无从区分）');
});

test('⑥ 入口已注册：PANELS 含 diagnostics，Router 认可 #pane=diagnostics', async () => {
  assert.ok(
    PANELS.some((p) => p.key === 'diagnostics'),
    'PANELS 必须含 diagnostics（否则面板选择器里看不到该入口）',
  );
  // `parseHash()` **不吃参数**——它读 `location.hash`（浏览器不可用时回落空串并给默认面板）。
  // 故判据必须像浏览器那样先摆好 hash，再调它（首版把 hash 当参数传，读到的是默认值 ⇒ 假红）。
  const saved = globalThis.location;
  try {
    // 判据只关心 hash；Location 其余字段不可构造，按边界口径收窄（例外 a）
    globalThis.location = { hash: '#pane=diagnostics' } as unknown as Location;
    assert.strictEqual(parseHash().pane, 'diagnostics', 'Router 必须认可该 pane');
    // **正对照**：未注册的 pane 必须回落默认（否则上面的断言可能只是"恒等于入参"）。
    globalThis.location = { hash: '#pane=__no_such_pane__' } as unknown as Location;
    assert.strictEqual(parseHash().pane, 'tools', '未注册 pane 应回落默认');
  } finally {
    globalThis.location = saved;
  }
});
