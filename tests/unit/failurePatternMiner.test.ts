// T4.3（H3 失败模式自动挖掘）可证伪验收：
//   ① 签名聚类：同 kind × 域的失败归入同签名，计数与样本正确；
//   ② 频率升格：≥ 阈值的签名成为改进提案（频次降序）；
//   ③ ≥1 条改进被采纳：真实登记（证据 = 本会话实际落地的检测器与门禁提交）并出现在台账；
//   ④ 确定性：同失败流重复挖掘 20 次提案集完全一致。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FailurePatternMiner,
  type FailureRecord,
} from '../../src/evolution/failurePatternMiner.js';

const RECORDS: readonly FailureRecord[] = [
  {
    kind: 'test:assert',
    location: 'tests/unit/appServer.test.ts:27',
    message: 'threads.create 返回结构不符',
  },
  {
    kind: 'test:assert',
    location: 'tests/unit/appServer.test.ts:28',
    message: 'turns.run 事件缺失',
  },
  { kind: 'test:assert', location: 'tests/unit/appServer.test.ts:29', message: '审批上行未接构造' },
  { kind: 'gate:delta', location: 'src/eval/rewardCoverageMeter.ts', message: '新文件缺 @returns' },
  { kind: 'eval:passk', location: 'evals/live/bench.mjs', message: 'Pass@3 落阈值附近随机红' },
];

test('① 签名聚类：kind × 域归簇，计数与样本正确', () => {
  const miner = new FailurePatternMiner(3);
  const { signatures } = miner.mine(RECORDS);
  const appServer = signatures.find((s) => s.key === 'test:assert × tests');
  assert.ok(appServer, 'tests 域应成簇');
  assert.strictEqual(appServer!.count, 3);
  assert.strictEqual(appServer!.samples.length, 2, '样本封顶 2 条');
});

test('② 频率升格：≥3 次的签名成为提案（按频次降序）', () => {
  const miner = new FailurePatternMiner(3);
  const { proposals } = miner.mine(RECORDS);
  assert.strictEqual(proposals.length, 1, '仅 tests 域 3 次达标');
  assert.strictEqual(proposals[0]!.signatureKey, 'test:assert × tests');
  assert.match(proposals[0]!.summary, /机械门禁|检测器|清单判据/);
});

test('③ ≥1 条改进被采纳：登记真实证据进台账', () => {
  const miner = new FailurePatternMiner(3);
  const { proposals } = miner.mine(RECORDS);
  const entry = miner.adopt(proposals[0]!, 'b71ba80 测试密闭化整类扫尾（app-server 5 项转绿）');
  assert.strictEqual(miner.adoptedLedger().length, 1);
  assert.strictEqual(entry.signatureKey, 'test:assert × tests');
  assert.match(entry.evidence, /b71ba80/);
  assert.ok(miner.adoptedLedger().length >= 1, 'H3 验收：台账 ≥1 条被采纳改进');
});

test('④ 确定性：同失败流重复挖掘 20 次提案集完全一致', () => {
  const run = () => {
    const miner = new FailurePatternMiner(3);
    return miner.mine(RECORDS).proposals.map((p) => [p.signatureKey, p.occurrences]);
  };
  const first = run();
  for (let i = 0; i < 19; i++) assert.deepStrictEqual(run(), first, '同输入必须恒同提案集');
});

test('⑤ 边界：空失败流零提案；阈值 1 时单条也升格', () => {
  const miner = new FailurePatternMiner(3);
  assert.deepStrictEqual(miner.mine([]).proposals, []);
  const eager = new FailurePatternMiner(1);
  assert.strictEqual(
    eager.mine([{ kind: 'gate:delta', location: 'src/x.ts', message: 'm' }]).proposals.length,
    1,
  );
});
