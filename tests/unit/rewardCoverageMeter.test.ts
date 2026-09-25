// T5.1（势函数覆盖率体检）可证伪验收：
//   ① 区分「真判负」与「不可验证」：命令真实跑失败 = verified-fail；命令缺失 = unverifiable；
//   ② 覆盖率出数：混合样本 → 精确数字；全不可验证 → coverage 0；
//   ③ 诚实降级表述：低于阈值必须使用降级措辞（不得声称有效 RLVR 信号）；达标用达标措辞；
//   ④ 确定性：同输入重复体检 20 次报告完全一致；
//   ⑤ wrap 后数值口径与原 VerifiableRewardFn 兼容（绿=1/失败/异常=0，fail-closed 不变）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CommandRewardProbe,
  RewardCoverageMeter,
  RewardCoverageReport,
  COVERAGE_THRESHOLD,
} from '../../src/evolution/rewardCoverageMeter.js';

test('① 区分真判负与不可验证：verified-fail ≠ unverifiable:no-command', async () => {
  const outcomes: Array<{ cmd: string | undefined; status: number | null }> = [
    { cmd: 'node good.js', status: 0 }, // 真 1
    { cmd: 'node bad.js', status: 1 }, // 真判负 0（可验证）
    { cmd: undefined, status: null }, // 不可验证 0
  ];
  const probe = new CommandRewardProbe(
    (c: unknown) => (c as { cmd: string | undefined }).cmd,
    undefined,
    (cmd) => ({ status: outcomes.find((o) => o.cmd === cmd)!.status }),
  );
  const r1 = await probe.verify({ cmd: 'node good.js' });
  const r2 = await probe.verify({ cmd: 'node bad.js' });
  const r3 = await probe.verify({ cmd: undefined });
  assert.deepStrictEqual([r1.verifiable, r1.reward], [true, 1]);
  assert.deepStrictEqual([r2.verifiable, r2.reward], [true, 0], '真实失败也是有效判定（可验证）');
  assert.deepStrictEqual([r3.verifiable, r3.reward], [false, 0], '无命令 ≠ 判负');
});

test('② 覆盖率出数：混合样本精确计数', async () => {
  const outcomes: Record<string, { status: number | null }> = {
    'node a.js': { status: 0 },
    'node b.js': { status: 1 },
  };
  const meter = new RewardCoverageMeter();
  const reward = meter.wrap(
    new CommandRewardProbe(
      (c: unknown) => (c as { cmd: string | undefined }).cmd,
      undefined,
      (cmd) => outcomes[cmd] ?? { status: null },
    ),
  );
  await reward({ cmd: 'node a.js' }); // verified
  await reward({ cmd: 'node b.js' }); // verified
  await reward({ cmd: undefined }); // unverifiable
  await reward({ cmd: 'node ghost.js' }); // 桩回 status null → ?? -1 → verified-fail（真实跑了）
  const rep = meter.report();
  assert.strictEqual(rep.samples, 4);
  assert.strictEqual(rep.verified, 3, '桩回 null 状态按退出码 -1 计 verified-fail（真实跑了）');
  assert.strictEqual(rep.unverifiable, 1);
  assert.ok(Math.abs(rep.coverage - 0.75) < 1e-9);
});

test('②b 全不可验证：coverage 0 且诚实降级', async () => {
  const meter = new RewardCoverageMeter();
  const reward = meter.wrap(
    new CommandRewardProbe(
      () => undefined,
      undefined,
      () => ({ status: 0 }),
    ),
  );
  await reward({});
  await reward({});
  const rep = meter.report();
  assert.strictEqual(rep.coverage, 0);
  assert.match(rep.honestNote, /不得声称|稀疏/);
});

test('③ 诚实降级表述：低于阈值降级、达标用达标措辞', () => {
  assert.match(new RewardCoverageReport(10, 3).honestNote, /稀疏/);
  assert.match(new RewardCoverageReport(10, 3).honestNote, /不得声称有效 RLVR/);
  assert.match(new RewardCoverageReport(10, Math.ceil(10 * COVERAGE_THRESHOLD)).honestNote, /可用/);
  assert.match(new RewardCoverageReport(10, 10).honestNote, /可用/);
});

test('④ 确定性：同输入重复体检 20 次报告完全一致', async () => {
  const run = async () => {
    const meter = new RewardCoverageMeter();
    const reward = meter.wrap(
      new CommandRewardProbe(
        (c: unknown) => (c as { cmd: string }).cmd,
        undefined,
        (cmd) => ({ status: cmd.includes('bad') ? 1 : 0 }),
      ),
    );
    await reward({ cmd: 'node a.js' });
    await reward({ cmd: 'node bad.js' });
    await reward({ cmd: undefined });
    return meter.report();
  };
  const first = await run();
  for (let i = 0; i < 19; i++) assert.deepStrictEqual(await run(), first);
  assert.strictEqual(first.coverage, 2 / 3);
});

test('⑤ wrap 兼容：异常样本 fail-closed 记 0 且计为不可验证（不假通过）', async () => {
  const meter = new RewardCoverageMeter();
  const reward = meter.wrap({
    verify: async () => {
      throw new Error('runner exploded');
    },
  });
  assert.strictEqual(await reward({}), 0);
  const rep = meter.report();
  assert.strictEqual(rep.unverifiable, 1);
  assert.match(rep.honestNote, /稀疏/);
});
