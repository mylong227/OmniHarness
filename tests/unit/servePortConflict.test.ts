/**
 * 端口冲突**诊断与显式接管**判据（2026-10-11）。
 *
 * ## 背景（实测教训，写在判据里防复发）
 *
 * 一个两天前启动的旧 `serve` 占着 8787 ⇒ **每次** `npm start` 都只回一句
 * `listen EADDRINUSE: address already in use 127.0.0.1:8787`：用户既不知道占用者是谁，
 * 也不知道让路有几条。本判据钉住"报错必须可行动 + 接管必须显式且只能杀自己人"。
 *
 * ## 判据口径
 *
 * | # | 判据 | 坏掉的后果 |
 * | --- | --- | --- |
 * | ① | `probe` 三分类：本程序健康体⇒`omni`；有响应但形状不符⇒`foreign`；连不上⇒`free` | 把别人的进程当成自己人 ⇒ 会去杀它 |
 * | ② | **fail-closed**：缺 `pid` / `status` 非 ok / 非 JSON / 4xx 一律 `foreign`（附正对照） | 误判成自己人 |
 * | ③ | `advice` 必须给出三条出路（换端口 / 停 PID / `--take-port`），且**只对自家人**提接管 | 提示不可行动 ⇒ 用户继续卡住；或诱导用户去杀别人的进程 |
 * | ④ | `takeOver` 仅对 `omni` + 正整数 PID 调 kill；`foreign` / 缺 PID ⇒ 返回 false 且 kill **未被调用** | 顺手杀掉无关进程（最危险的一类"修复"） |
 * | ⑤ | 接线：`serve` 路径必须在 `server.start` 失败时调用 `probe`/`advice`，且 `--take-port` 已登记进 knownFlags | 改了模块却没人用（判据全绿而行为未变） |
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ServePortConflict,
  type PortHolder,
  type ServePortConflictDeps,
} from '../../src/cli/servePortConflict.ts';

/** 仓库根。 */
const REPO_ROOT = process.cwd();
/** 目标端口（仅作字面量参与提示文本，不真连）。 */
const PORT = 8787;

/**
 * 造一个返回给定健康体的 fetch 替身。
 * @param body 响应体（字符串或对象）
 * @param status HTTP 状态码
 * @returns 假 fetch
 */
function fetchReturning(body: unknown, status = 200): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    )) as unknown as typeof fetch;
}

/** 造一个总是抛错的 fetch 替身（模拟端口空闲/超时）。 */
function fetchThrowing(message = 'connect ECONNREFUSED'): typeof fetch {
  return (() => Promise.reject(new Error(message))) as unknown as typeof fetch;
}

test('①/② probe 三分类，且形状不符一律 fail-closed 判 foreign', async () => {
  const omni = await ServePortConflict.probe(PORT, {
    fetchImpl: fetchReturning({ status: 'ok', uptimeSeconds: 173_763, pid: 25460, checks: {} }),
  });
  assert.strictEqual(omni.kind, 'omni', '本程序健康体必须判为 omni');
  assert.strictEqual(omni.pid, 25460);
  assert.strictEqual(omni.uptimeSeconds, 173_763);

  const free = await ServePortConflict.probe(PORT, { fetchImpl: fetchThrowing() });
  assert.strictEqual(free.kind, 'free', '连不上必须判为空闲');

  // **fail-closed 正对照**：四种"看着像但不是"的响应都必须判 foreign（否则会去杀别人的进程）。
  const impostors: readonly [string, unknown, number][] = [
    ['缺 pid', { status: 'ok', uptimeSeconds: 10, checks: {} }, 200],
    ['status 不是 ok', { status: 'degraded', pid: 123, checks: {} }, 200],
    ['pid 非正整数', { status: 'ok', pid: -1, checks: {} }, 200],
    ['pid 是字符串', { status: 'ok', pid: '123', checks: {} }, 200],
  ];
  for (const [label, body, status] of impostors) {
    const holder = await ServePortConflict.probe(PORT, {
      fetchImpl: fetchReturning(body, status),
    });
    assert.strictEqual(holder.kind, 'foreign', `${label} 必须判 foreign（不得当自己人）`);
    assert.strictEqual(holder.pid, undefined, `${label} 不得给出可杀的 PID`);
  }
  const notJson = await ServePortConflict.probe(PORT, { fetchImpl: fetchReturning('<html>', 200) });
  assert.strictEqual(notJson.kind, 'foreign', '非 JSON 响应必须判 foreign');
  const forbidden = await ServePortConflict.probe(PORT, {
    fetchImpl: fetchReturning({ status: 'ok', pid: 1 }, 403),
  });
  assert.strictEqual(forbidden.kind, 'foreign', '4xx 响应必须判 foreign');
});

test('③ advice：必须给三条出路；对"别人的进程"不得提接管', () => {
  const omni: PortHolder = { kind: 'omni', pid: 25460, uptimeSeconds: 173_763, detail: 'x' };
  const ours = ServePortConflict.advice(PORT, omni);
  assert.match(ours, /8787/u, '必须点明端口');
  assert.match(ours, /25460/u, '必须点明占用者 PID（用户才能精确停掉它）');
  assert.match(ours, /--port 8788/u, '出路一：换端口（并给出具体命令）');
  assert.match(ours, /Stop-Process -Id 25460|kill 25460/u, '出路二：停掉那个 PID（按平台给命令）');
  assert.match(ours, /--take-port/u, '出路三：显式接管');
  assert.match(
    ours,
    /只.*OmniHarness serve|仅当占用者确认是 OmniHarness serve/u,
    '必须说明接管的边界',
  );

  const foreign: PortHolder = { kind: 'foreign', detail: '/healthz 有响应但不是本程序的健康体' };
  const other = ServePortConflict.advice(PORT, foreign);
  assert.match(other, /非本程序的进程/u, '必须如实说明占用者不是自己人');
  assert.doesNotMatch(other, /--take-port/u, '对别人的进程不得提供接管（本程序无权杀它）');
  assert.match(other, /Get-NetTCPConnection|lsof/u, '应给出找出占用者的命令');
});

test('④ takeOver：只对 omni + 正整数 PID 动手；否则 kill 必须**未被调用**', async () => {
  const killed: number[] = [];
  const deps: ServePortConflictDeps = {
    kill: (pid) => killed.push(pid),
    waitFree: () => Promise.resolve(true),
  };

  // 自家人 ⇒ 杀它并等释放。
  const omni: PortHolder = { kind: 'omni', pid: 4242, detail: 'x' };
  assert.strictEqual(await ServePortConflict.takeOver(PORT, omni, deps), true);
  assert.deepStrictEqual(killed, [4242], '确认是自己人时必须终止它');

  // 别人的进程 / 缺 PID / PID 非法 ⇒ 一律拒绝，且**不得**调用 kill。
  killed.length = 0;
  for (const [label, holder] of [
    ['foreign', { kind: 'foreign', detail: 'x' }],
    ['omni 但缺 PID', { kind: 'omni', detail: 'x' }],
    ['omni 但 PID 非法', { kind: 'omni', pid: 0, detail: 'x' }],
    ['free', { kind: 'free', detail: 'x' }],
  ] as const) {
    assert.strictEqual(
      await ServePortConflict.takeOver(PORT, holder as PortHolder, deps),
      false,
      `${label} 必须拒绝接管`,
    );
  }
  assert.deepStrictEqual(
    killed,
    [],
    '拒绝路径**绝不能**调用 kill（顺手杀别人进程是最危险的一类"修复"）',
  );
});

test('⑤ 接线：serve 路径必须实现"失败即诊断/按需接管"，且 --take-port 已登记', () => {
  const source = readFileSync(join(REPO_ROOT, 'src/cli/cliServerCmds.ts'), 'utf8');
  assert.match(
    source,
    /catch \(error\)[\s\S]{0,400}?ServePortConflict\.probe\(port\)/u,
    '绑定失败必须 probe 占用者',
  );
  // 2026-10-15：调用多带了一个实参（实例记录）⇒ 断言随之改为钉"调用形状 + 记录接线"，
  // 而不是钉死当时的实参个数（后者会让"加了信息"这种改进变成假红）。
  assert.match(
    source,
    /ServePortConflict\.advice\(port, holder,/u,
    '必须把可行动提示打给用户（并带上实例记录）',
  );
  assert.match(source, /ServeInstance\.announce\(/u, '绑定成功后必须写下实例记录');
  assert.match(source, /ServeInstance\.sweep\(/u, '启动/冲突时必须清扫已死进程留下的陈旧记录');
  assert.match(
    source,
    /ServeInstance\.retire\(instancePath\)/u,
    '正常退出必须退役记录（只删自己的）',
  );
  assert.match(source, /ServePortConflict\.takeOver\(port, holder\)/u, '必须实现显式接管');
  assert.match(source, /serveArgs\.includes\('--take-port'\)/u, '接管必须由 --take-port 显式请求');

  // **正对照**：把 probe 那行删掉，接线断言必须变红（否则本判据只是"文件里有这些字"）。
  const mutated = source.replace('ServePortConflict.probe(port)', 'probeNothing(port)');
  assert.notStrictEqual(mutated, source, '正对照变异未落地');
  assert.doesNotMatch(
    mutated,
    /catch \(error\)[\s\S]{0,400}?ServePortConflict\.probe\(port\)/u,
    '删掉诊断调用却检不出来 ⇒ 判据⑤恒真',
  );
  // 第二条正对照（本轮新增的接线）：把退役调用删掉 ⇒ 必须检得出来。
  assert.doesNotMatch(
    source.replace('ServeInstance.retire(instancePath)', 'retireNothing(instancePath)'),
    /ServeInstance\.retire\(instancePath\)/u,
    '删掉退役调用却检不出来 ⇒ 新增的接线断言恒真',
  );

  const flags = readFileSync(join(REPO_ROOT, 'src/cli/knownFlags.ts'), 'utf8');
  assert.match(
    flags,
    /'--take-port'/u,
    '--take-port 必须登记进 knownFlags（否则会被未知旗标 fail-closed 打死）',
  );
});
