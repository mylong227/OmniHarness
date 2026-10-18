/**
 * 覆盖率门禁的**捕获预算与失败分类**判据（2026-10-11）。
 *
 * ## 它盯的是什么
 *
 * 该门禁要捕获整套测试的 TAP 输出才能提取失败行与覆盖率表。此前 `execFileSync` **没设
 * `maxBuffer`** ⇒ 用 Node 缺省 1MB ⇒ 全量套件输出一超线就是 `spawnSync … ENOBUFS`，
 * 而 catch 把它报成"**测试可能根本没跑起来**"。实测：门禁在**本来就全绿**的套件上自杀，
 * 且给出的是误导性归因（把"门禁读不下输出"伪装成"测试没启动"——与 2026-10-06 那次
 * "把运维故障伪装成用例失败"同一形态）。本文件把这条钉死：
 *
 * | # | 判据 | 坏掉的后果 |
 * | --- | --- | --- |
 * | ① | 分类器把 `ENOBUFS` 判成 `capture-overflow`、`ENOENT/EACCES` 判成 `spawn-failed`、其余 `other` | 又回到"一律归因成测试没跑起来" |
 * | ② | 门禁源码必须显式把 `maxBuffer` 传给 `execFileSync（且预算 ≥ 8MB） | 套件一长大门禁就随机自杀 |
 * | ③ | 门禁对 `capture-overflow` 必须给**不同的**文案（不得仍是"测试可能根本没跑起来"） | 运维读到误导归因 |
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 仓库根（判据脚本自身在 `dist/tests/unit/`，而 `scripts/` 不参与编译 ⇒ 按 cwd 解析）。 */
const REPO_ROOT = process.cwd();

/** 被判据盯着的分类器模块形状。 */
interface ChildRunFailureModule {
  readonly MAX_CAPTURE_BYTES: number;
  readonly classifyRunFailure: (error: unknown) => 'capture-overflow' | 'spawn-failed' | 'other';
}

/**
 * 载入 `scripts/lib/childRunFailure.mjs`。
 *
 * 用**按 cwd 解析的动态 import** 而不是相对字面量：该模块是门禁脚本侧的原生 ESM，
 * 不参与 tsc 编译（`dist/scripts/**` 不存在），故 `dist/tests/**` 里的相对路径必然解析失败。
 * @returns 模块导出（形状见上）。
 */
async function loadClassifier(): Promise<ChildRunFailureModule> {
  const url = pathToFileURL(join(REPO_ROOT, 'scripts', 'lib', 'childRunFailure.mjs')).href;
  const mod = (await import(url)) as ChildRunFailureModule;
  return mod;
}

/** 覆盖率门禁源码。 */
function gateSource(): string {
  return readFileSync(join(REPO_ROOT, 'scripts', 'coverageGate.mjs'), 'utf8');
}

test('① 失败分类：ENOBUFS=捕获溢出 / ENOENT·EACCES=spawn 失败 / 其余=other', async () => {
  const { classifyRunFailure, MAX_CAPTURE_BYTES } = await loadClassifier();
  const enobufs = Object.assign(new Error('spawnSync cmd.exe ENOBUFS'), { code: 'ENOBUFS' });
  assert.strictEqual(classifyRunFailure(enobufs), 'capture-overflow');
  assert.strictEqual(
    classifyRunFailure(new Error('spawnSync … ENOBUFS')),
    'capture-overflow',
    '只有 message 里带 ENOBUFS 时也要能认出来（部分环境下 code 缺失）',
  );
  assert.strictEqual(
    classifyRunFailure(Object.assign(new Error('x'), { code: 'ENOENT' })),
    'spawn-failed',
  );
  assert.strictEqual(
    classifyRunFailure(Object.assign(new Error('x'), { code: 'EACCES' })),
    'spawn-failed',
  );
  assert.strictEqual(
    classifyRunFailure(Object.assign(new Error('1 test failed'), { status: 1 })),
    'other',
  );

  // **正对照**：把 ENOBUFS 样本喂给分类器，结果必须**不是** 'other'（否则它就等于没有分类）。
  assert.notStrictEqual(classifyRunFailure(enobufs), 'other', '分类器认不出捕获溢出 ⇒ 判据恒真');
  assert.ok(Number.isFinite(MAX_CAPTURE_BYTES) && MAX_CAPTURE_BYTES > 0, '捕获预算必须是正数');
});

test('② 门禁必须显式给足 maxBuffer（≥ 8MB），不得吃缺省的 1MB', async () => {
  const { MAX_CAPTURE_BYTES } = await loadClassifier();
  const source = gateSource();
  assert.match(
    source,
    /maxBuffer:\s*MAX_CAPTURE_BYTES/u,
    'execFileSync 必须显式传 maxBuffer（缺省 1MB 会让套件长大后门禁随机自杀）',
  );
  assert.ok(
    MAX_CAPTURE_BYTES >= 8 * 1024 * 1024,
    `捕获预算过小（${String(MAX_CAPTURE_BYTES)} 字节）⇒ 挡不住已知的 ENOBUFS`,
  );
  // 正对照：源码里必须真的出现该选项（只 import 不用 = 没接线）。
  const uses = [...source.matchAll(/maxBuffer:/gu)].length;
  assert.ok(uses >= 1, '源码里没有 maxBuffer 选项 ⇒ ② 形同虚设');
});

test('③ 「没跑起来」必须**分类**而非一律归因（旧版查 capture-overflow 分支，v8 后该模式消失）', () => {
  const source = gateSource();

  // ## 这条判据的沿革（2026-10-18 覆盖率迁 v8 时重写）
  //
  // 旧断言找的是门禁源码里的 `kind === 'capture-overflow'` 分支：那时门禁用
  // `execFileSync(..., maxBuffer)` **捕获** coverage 的 stdout，输出超限会 `ENOBUFS`，
  // 必须有独立文案（"缓冲不足、调大 maxBuffer"），否则运维会把"门禁自己读不下输出"
  // 误读成"测试没跑起来"。
  //
  // 迁到 v8 后 `stdio` 改成 `inherit`（**不再捕获** stdout/stderr，直接透传给人看），
  // 于是 `maxBuffer` 不再作用于输出、`capture-overflow` 这个失败模式**在覆盖率路径上消失**。
  // 判据因此改为守**新的等价物**：失败必须带上分类标签——`capture-overflow` / OOM / spawn 失败
  // 在运维眼里必须是三条可区分的消息，而不是同一条"测试可能根本没跑起来"。
  //
  // 断言强度没有放松：旧版要求"溢出分支点明缓冲不足"，新版要求"分类必须真的被算出来并打印"。
  assert.match(
    source,
    /classifyRunFailure\(/u,
    '门禁必须调用 classifyRunFailure：否则「没跑起来」只能给出统一归因，运维无法区分 ENOBUFS / OOM / spawn 失败',
  );
  assert.match(
    source,
    /分类=\$/u,
    '分类结果必须打印给运维（`分类=` 字段）——只算不打印等于没有分类',
  );
  // 反向：不得再退回"只给一句统一归因、不带分类"的写法。
  const crashMsg = source.indexOf('测试可能根本没跑起来');
  assert.ok(crashMsg > 0, '找不到「没跑起来」的提示文案');
  const window = source.slice(crashMsg, crashMsg + 600);
  assert.match(
    window,
    /分类=/u,
    '「没跑起来」提示的邻近代码必须附上分类字段（该提示单独出现时不可区分失败模式）',
  );
});

test('④ 清点分类必须**单一来源**：报告分支与 --dump-inventory 分支都走 classifyMissingArtifacts', () => {
  const source = gateSource();
  const uses = [...source.matchAll(/classifyMissingArtifacts\(/gu)].length;
  // 一处是定义、两处是调用 ⇒ ≥ 3。
  assert.ok(
    uses >= 3,
    `classifyMissingArtifacts 只出现 ${String(uses)} 次 ⇒ 有一条分支没用同一份判定` +
      '（2026-10-11 实测：dump 分支漏过滤，把 9 个纯类型端口模块误报成"新增未覆盖"）',
  );
  // 反向：两条分支都不得再各自手写 `filter((f) => !reported...` 那套（否则口径又会分叉）。
  const handRolled = [...source.matchAll(/included\.filter\(\(f\) => !reported/gu)].length;
  assert.strictEqual(
    handRolled,
    0,
    '仍有分支在自行过滤"没进报告"的文件 ⇒ 纯类型排除规则会在该分支失效',
  );
  // **正对照**：把某处调用换回手写过滤，检测器必须能认出来。
  const mutated = source.replace(
    'const { missing, typeOnly } = classifyMissingArtifacts(included, reported);',
    'const missing = included.filter((f) => !reported.has(f));',
  );
  assert.notStrictEqual(mutated, source, '正对照变异未命中 ⇒ 判据锚点漂了');
  assert.ok(
    [...mutated.matchAll(/classifyMissingArtifacts\(/gu)].length < 3 ||
      [...mutated.matchAll(/included\.filter\(\(f\) => !reported/gu)].length > 0,
    '换回手写过滤却检不出来 ⇒ 判据④恒真',
  );
});
