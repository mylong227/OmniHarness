/**
 * S7（GEE Kernel v1 · ADR-0008）：evolution CLI 子命令判据。
 *
 * 蓝图判据（EVOLUTION_ARCH_UPGRADE_2026-10 §4 S7）：
 * - **只读命令不触发改动**：`evolution status` 跑完后台账文件与技能包目录逐字节不变；
 * - **rollback 需 `--yes`**：不给即拒（退出码 2，零改动）；给了才写台账与还原技能包；
 * - 断链 fail-closed：验签红时 status 非零退出、rollback 拒绝执行（不制造第二本假账）；
 * - 附加：还原技能包是 `--skills` 能直接吃回去的格式（`{ "skills": [...] }`）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EvolutionCommand } from '../../src/cli/evolutionCommand.js';
import { HashChainPromotionLedger } from '../../src/evolution/hashChainPromotionLedger.js';
import { ConfigError } from '../../src/config/configError.js';
import type { Skill } from '../../src/skill/skill.js';

/**
 * 造技能。
 * @param name 技能名
 * @returns Skill
 */
function skillOf(name: string): Skill {
  return { name, description: `${name} 描述`, instructions: `${name} 步骤。`, tags: [name] };
}

/**
 * 建一个已含「快照 → 晋升 → 回滚」历史的工作区。
 * @returns 工作区根目录与台账目录
 */
function seededWorkspace(): { readonly root: string; readonly dir: string } {
  const root = mkdtempSync(join(tmpdir(), 'omni-evo-cli-'));
  const dir = join(root, '.omniharness', 'evolution');
  const ledger = new HashChainPromotionLedger({
    dir,
    now: (): string => '2026-10-04T00:00:00.000Z',
  });
  ledger.snapshotBefore([skillOf('a'), skillOf('b')]);
  ledger.append({ name: 'crystal:x', source: 'twist:a+b' });
  return { root, dir };
}

/**
 * 采集 stdout/stderr（命令协作者按 CLI 契约写这两条流）。
 * @param run 被测动作
 * @returns 两条流的文本与动作结果
 */
async function capture<T>(
  run: () => Promise<T>,
): Promise<{ readonly out: string; readonly err: string; readonly result: T }> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    outChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    errChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await run();
    return { out: outChunks.join(''), err: errChunks.join(''), result };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

test('S7 status 只读：跑完后台账文件逐字节不变、目录零新增', async () => {
  const { root, dir } = seededWorkspace();
  const ledgerPath = join(dir, 'ledger.jsonl');
  const before = readFileSync(ledgerPath, 'utf8');
  const filesBefore = readdirSync(dir).sort();

  const { out, result } = await capture(() =>
    new EvolutionCommand().run(['status', '--workspace', root, '--json']),
  );
  assert.strictEqual(result, 0, '完整台账 → 退出码 0');
  const report = JSON.parse(out.trim()) as {
    ok: boolean;
    entries: number;
    snapshots: number;
    promotions: number;
    latestSnapshotSeq: number;
  };
  assert.deepStrictEqual(
    {
      ok: report.ok,
      entries: report.entries,
      snapshots: report.snapshots,
      promotions: report.promotions,
      latestSnapshotSeq: report.latestSnapshotSeq,
    },
    { ok: true, entries: 2, snapshots: 1, promotions: 1, latestSnapshotSeq: 1 },
  );
  assert.strictEqual(readFileSync(ledgerPath, 'utf8'), before, '只读命令不得改动台账');
  assert.deepStrictEqual(readdirSync(dir).sort(), filesBefore, '只读命令不得新增文件');
});

test('S7 status fail-closed：台账断链 ⇒ 非零退出且如实点名断裂处（不当成功）', async () => {
  const { root, dir } = seededWorkspace();
  const ledgerPath = join(dir, 'ledger.jsonl');
  const lines = readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  const tampered = JSON.parse(lines[1]!) as { promoted: { name: string } };
  tampered.promoted.name = 'forged';
  lines[1] = JSON.stringify(tampered);
  writeFileSync(ledgerPath, lines.join('\n') + '\n', 'utf8');

  const { out, result } = await capture(() =>
    new EvolutionCommand().run(['status', '--workspace', root, '--json']),
  );
  assert.strictEqual(result, 1, '验签红 ⇒ 非零退出');
  const report = JSON.parse(out.trim()) as { ok: boolean; brokenAt: number };
  assert.strictEqual(report.ok, false);
  assert.strictEqual(report.brokenAt, 2, '断裂处定位到被改条目');
});

test('S7 rollback 门禁：缺 --yes 即拒（退出码 2），台账与目录零改动', async () => {
  const { root, dir } = seededWorkspace();
  const ledgerPath = join(dir, 'ledger.jsonl');
  const before = readFileSync(ledgerPath, 'utf8');
  const filesBefore = readdirSync(dir).sort();

  const { err, result } = await capture(() =>
    new EvolutionCommand().run(['rollback', '--seq', '1', '--workspace', root]),
  );
  assert.strictEqual(result, 2, '写操作缺 --yes ⇒ 用法错误');
  assert.match(err, /必须显式加 --yes/);
  assert.strictEqual(readFileSync(ledgerPath, 'utf8'), before, '被拒的回滚不得写台账');
  assert.deepStrictEqual(readdirSync(dir).sort(), filesBefore, '被拒的回滚不得产出文件');
});

test('S7 rollback --yes：还原计划写成 --skills 可吃的技能包，且回滚事件入链', async () => {
  const { root, dir } = seededWorkspace();
  const { out, result } = await capture(() =>
    new EvolutionCommand().run(['rollback', '--seq', '1', '--yes', '--workspace', root, '--json']),
  );
  assert.strictEqual(result, 0, '完整台账 + --yes ⇒ 成功');
  const summary = JSON.parse(out.trim()) as { seq: number; restored: number; out: string };
  assert.deepStrictEqual({ seq: summary.seq, restored: summary.restored }, { seq: 1, restored: 2 });

  // 产物格式必须与 `CliSkillFlags` 同一口径：`{ "skills": [...] }`（否则接不回下一次会话）。
  const pack = ConfigError.normalizeSkillEntries(
    JSON.parse(readFileSync(summary.out, 'utf8')),
    'rollback pack',
  );
  assert.deepStrictEqual(
    pack.map((s) => s.name),
    ['a', 'b'],
    '还原包 = 快照时技能表（晋升者不在其中）',
  );
  const ledger = new HashChainPromotionLedger({ dir });
  assert.strictEqual(ledger.verify().ok, true, '回滚事件入链后链仍完整');
  assert.strictEqual(
    ledger.list().filter((e) => e.action === 'rollback').length,
    1,
    '治理事件不隐身：台账留下 rollback 条目',
  );
});

test('S7 rollback 非法 seq：无可用快照时 fail-closed 拒绝（退出码 1），不静默空还原', async () => {
  // 只含 promote 条目（链中无 snapshot）⇒ 任何 seq 都定位不到快照。
  const root = mkdtempSync(join(tmpdir(), 'omni-evo-cli-'));
  const ledger = new HashChainPromotionLedger({ dir: join(root, '.omniharness', 'evolution') });
  ledger.append({ name: 'x', source: 'twist:a+b' });
  const { err, result } = await capture(() =>
    new EvolutionCommand().run(['rollback', '--seq', '1', '--yes', '--workspace', root]),
  );
  assert.strictEqual(result, 1);
  assert.match(err, /定位不到快照/);
});

test('S7 rollback 断链：验签红 ⇒ 拒绝回滚（不制造第二本假账）', async () => {
  const { root, dir } = seededWorkspace();
  const ledgerPath = join(dir, 'ledger.jsonl');
  writeFileSync(ledgerPath, readFileSync(ledgerPath, 'utf8') + '{"broken": tru', 'utf8');
  const { err, result } = await capture(() =>
    new EvolutionCommand().run(['rollback', '--seq', '1', '--yes', '--workspace', root]),
  );
  assert.strictEqual(result, 1);
  assert.match(err, /fail-closed 拒绝回滚/);
});

test('S7 cycle 门禁：缺 --yes 即拒且不调钩子；有 --yes 才委托钩子', async () => {
  const calls: { argv: readonly string[]; json: boolean }[] = [];
  const command = new EvolutionCommand((request) => {
    calls.push({ argv: request.argv, json: request.json });
    return Promise.resolve(0);
  });

  const rejected = await capture(() => command.run(['cycle']));
  assert.strictEqual(rejected.result, 2, '缺 --yes ⇒ 用法错误');
  assert.match(rejected.err, /必须显式加 --yes/);
  assert.deepStrictEqual(calls, [], '被拒的 cycle 绝不触发运行时装配');

  const ok = await capture(() => command.run(['cycle', '--yes', '--json']));
  assert.strictEqual(ok.result, 0);
  assert.deepStrictEqual(calls, [{ argv: ['--json'], json: true }], '--yes 被剥离后透传其余旗标');
});

test('S7 cycle 未接线：如实报用法错误（退出码 2），绝不假装成功', async () => {
  const { err, result } = await capture(() => new EvolutionCommand().run(['cycle', '--yes']));
  assert.strictEqual(result, 2);
  assert.match(err, /未接线/);
});

test('S7 未知子命令：打印用法并退出 2（不误当主任务执行）', async () => {
  const { out, result } = await capture(() => new EvolutionCommand().run(['bogus']));
  assert.strictEqual(result, 2);
  assert.match(out, /omniharness evolution status/);
});
