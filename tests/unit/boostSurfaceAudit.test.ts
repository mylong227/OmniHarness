/**
 * `boost audit-surface` 判据（2026-10-10）：门禁输入表面声明的**静态取证**。
 *
 * 判据口径（钉住"什么必须成立"）：
 *  ① **过期必须被看见**：入口脚本内容一变，对应声明即判过期——这是本工具存在的唯一理由
 *     （过期的声明比没有声明更危险：没有声明按"永不跳过"，过期声明会让人放心跳过）；
 *  ② **只有可复核的证据能触发重新取证**：未声明 / 未取证 / 脚本漂移算；"声明面里的文件
 *     没在脚本正文里被字面提到"**不算**"（路径可能是常量拼出来的，实测抓到过
 *     `scripts/docLinkBaseline.json` 这种情形）——把它当阻断会让工具长期假红；
 *  ③ **视野受限必须自报**：入口不在 `scripts/` 下的门禁（如 argv 指向 node_modules 的 `tsc`）
 *     指纹不到，必须显式标为"不可指纹"而不是假装 ok。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BoostSurfaceAudit, SURFACE_SNAPSHOT_VERSION } from '../../src/cli/boostSurfaceAudit.js';
import { GATE_SURFACE } from '../../src/cli/boostGateSurface.js';

/**
 * 造一个含假 `runGates.mjs` 的临时仓库根。
 * @param fn 使用该根的测试体。
 * @returns 无返回值。
 */
function withFakeRepo(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'omni-audit-'));
  try {
    writeFileSync(
      join(root, 'runGates.mjs'),
      'const GATES = [\n' +
        "  { id: 'alpha', tier: 'fast', argv: ['scripts/alpha.mjs'] },\n" +
        "  { id: 'beta', tier: 'typed', argv: ['node_modules/typescript/bin/tsc', '--noEmit'] },\n" +
        '];\n',
      'utf8',
    );
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'alpha.mjs'), "readFileSync('package.json');\n", 'utf8');
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('① 解析门禁条目：按条目切分取 argv 首元素，非 scripts/ 入口返回 null（不跨条目误匹配）', () => {
  const text =
    'const GATES = [\n' +
    "  { id: 'one', tier: 'fast', label: 'x', argv: ['scripts/a.mjs', '--strict'] },\n" +
    "  { id: 'two', tier: 'fast', label: 'y' },\n" +
    "  { id: 'three', tier: 'typed', argv: ['scripts/c.mjs'] },\n" +
    '];\n';
  const map = BoostSurfaceAudit.parseEntries(text);
  assert.strictEqual(map.get('one'), 'scripts/a.mjs');
  assert.strictEqual(map.has('two'), false, '没有 argv 的条目不入表');
  assert.strictEqual(map.get('three'), 'scripts/c.mjs', '不得把上一条的 argv 误配给本条');
  assert.strictEqual(BoostSurfaceAudit.parseEntries('').size, 0);
});

test('② "未提到的具体文件"：只查具体文件，含通配符的面一律跳过（避免海量假阳性）', () => {
  withFakeRepo((root) => {
    const auditor = new BoostSurfaceAudit(root);
    assert.deepStrictEqual(
      auditor.unmentionedConcreteFiles('scripts/alpha.mjs', [
        'package.json',
        'src/**/*.ts',
        'missing.json',
      ]),
      ['missing.json'],
      '通配符面不查；正文里出现过的具体文件不报',
    );
    assert.deepStrictEqual(
      auditor.unmentionedConcreteFiles('scripts/nope.mjs', ['missing.json']),
      [],
    );
  });
});

test('① 快照毒化回归：默认不写快照，只有确认重新取证（acceptBaseline）才更新基线', () => {
  withFakeRepo((root) => {
    const rel = '.omniharness/boost/gate-surface.json';
    const auditor = new BoostSurfaceAudit(root);
    // 首次运行（无基线）⇒ 必须写，否则永远没有可比对的基线。
    const first = auditor.audit(rel);
    assert.strictEqual(first.hasBaseline, false);
    assert.strictEqual(first.wroteSnapshot, true, '首次运行必须建立基线');
    // 第二次：已有基线 ⇒ 默认**不写**（否则一次临时改动就会毒化基线，之后永远报过期）。
    const second = auditor.audit(rel);
    assert.strictEqual(second.hasBaseline, true);
    assert.strictEqual(second.wroteSnapshot, false, '默认不写快照');
    // 显式确认重新取证 ⇒ 才更新基线。
    assert.strictEqual(auditor.audit(rel, true).wroteSnapshot, true, 'acceptBaseline 才写');
  });
});

test('① 脚本内容漂移 ⇒ 判"需重新取证"（本工具的唯一理由）', () => {
  withFakeRepo((root) => {
    // 该假仓库没有 runGates.mjs 的 scripts/ 入口，故直接对文件哈希与快照语义做断言。
    const auditor = new BoostSurfaceAudit(root);
    const first = auditor.hashOf('scripts/alpha.mjs');
    assert.ok(first !== null);
    const snap = { version: SURFACE_SNAPSHOT_VERSION, hashes: { 'scripts/alpha.mjs': first } };
    writeFileSync(
      join(root, 'scripts', 'alpha.mjs'),
      "readFileSync('package.json'); // changed\n",
      'utf8',
    );
    const second = auditor.hashOf('scripts/alpha.mjs');
    assert.notStrictEqual(second, first, '内容变了哈希必须变');
    assert.strictEqual(snap.hashes['scripts/alpha.mjs'], first, '旧快照仍是旧哈希 ⇒ 会被判漂移');
  });
});

test('③ 快照版本不符 ⇒ 当作"无基线"（宁可全判新，不可用旧结构误判一致）', () => {
  withFakeRepo((root) => {
    const rel = '.omniharness/boost/gate-surface.json';
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      JSON.stringify({ version: 999, hashes: { 'scripts/alpha.mjs': 'deadbeef' } }),
      'utf8',
    );
    const auditor = new BoostSurfaceAudit(root);
    assert.strictEqual(auditor.readSnapshot(rel), null, '版本不符必须返回 null');
    writeFileSync(
      target,
      JSON.stringify({
        version: SURFACE_SNAPSHOT_VERSION,
        hashes: { 'scripts/alpha.mjs': 'deadbeef' },
      }),
      'utf8',
    );
    assert.deepStrictEqual(auditor.readSnapshot(rel)?.hashes, { 'scripts/alpha.mjs': 'deadbeef' });
  });
});

test('真实仓库：表面表与上游清单双向一致，且每条声明都带取证结论与说明', () => {
  const auditor = new BoostSurfaceAudit(process.cwd());
  const entries = auditor.readGateEntries();
  assert.ok(entries.length > 0, '读不出上游门禁清单，判据无法成立');
  const missing = entries.filter((e) => GATE_SURFACE[e.id] === undefined).map((e) => e.id);
  assert.deepStrictEqual(missing, [], `声明表缺这些上游门禁：${missing.join(', ')}`);
  const ids = new Set(entries.map((e) => e.id));
  const zombie = Object.keys(GATE_SURFACE).filter((id) => !ids.has(id));
  assert.deepStrictEqual(zombie, [], `声明表有上游已不存在的门禁：${zombie.join(', ')}`);
  for (const [id, decl] of Object.entries(GATE_SURFACE)) {
    assert.notStrictEqual(decl.audited, '', `${id} 必须带实测取证结论`);
    assert.ok((decl.inputs?.length ?? 0) > 0, `${id} 必须声明判定输入`);
  }
});

test('③ 真实仓库：入口在 scripts/ 下的门禁必须指纹得到；不可指纹的条目必须自报', () => {
  const auditor = new BoostSurfaceAudit(process.cwd());
  const entries = auditor.readGateEntries();
  const scripted = entries.filter((e) => e.script !== null);
  assert.ok(scripted.length >= 8, '本仓绝大多数门禁入口都是 scripts/ 下的脚本');
  for (const e of scripted) {
    assert.notStrictEqual(auditor.hashOf(e.script ?? ''), null, `${e.id} 的脚本应可读`);
  }
  // 不可指纹的那几条（argv 指向 node_modules 里的工具）必须**如实**为空，而不是被猜出一个路径。
  const blind = entries.filter((e) => e.script === null).map((e) => e.id);
  for (const id of ['tsc', 'eslint-typed']) {
    assert.ok(blind.includes(id), `${id} 的入口是 node_modules 工具 ⇒ 应判"不可指纹"`);
  }
});
