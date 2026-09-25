/**
 * SSRF 策略表**配置化**的回归（2026-09-22，用户指令 + 审计）。
 *
 * 被改的形态：`METADATA_HOSTS` / `INTERNAL_SUFFIXES` / `IPV4_BLOCKS` 三张表原先硬编码在
 * `SsrfGuard` 里（想加自建元数据端点或放行某个内网域都得改代码重发）。现下沉为配置字段
 * `ssrfPolicy`，实现里只保留默认档。本测试钉住四件事：
 * ① **默认档与历史逐字一致**（零配置用户行为不变——这是配置化的前提）；
 * ② 自定义表**真的生效**（且是替换语义，不是静默合并）；
 * ③ 非法条目**抛错**而非静默丢弃（静默丢弃会让人以为配上了、实际护栏更松）；
 * ④ 配置段校验器与运行时解析器**同源**（同一份规则，不出现双口径）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SSRF_POLICY, SsrfPolicy } from '../../src/security/ssrfPolicy.js';
import { SsrfGuard } from '../../src/security/ssrfGuard.js';
import { NetworkEgressGuard } from '../../src/adapters/sandbox/networkEgressGuard.js';
import { ssrfPolicyValidator } from '../../src/config/ssrfPolicyValidator.js';
import { BuiltinDefaults, builtinDefaults } from '../../src/util/builtinDefaults.js';
import { ArgParser } from '../../src/cli/argParser.js';
import type { FileConfig } from '../../src/config/configFile.js';

/** 仓库根（dist/tests/unit → 上溯三级）。 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('① 默认档与历史逐字一致（零配置行为不变）', () => {
  assert.deepStrictEqual(
    [...DEFAULT_SSRF_POLICY.metadataHosts],
    ['169.254.169.254', '100.100.100.200', 'metadata.google.internal', 'metadata.goog'],
  );
  assert.deepStrictEqual(
    [...DEFAULT_SSRF_POLICY.internalSuffixes],
    // `.corp` 为 2026-09-22 配置化时**并入**：它原先只存在于出站守卫的私有主机正则里，
    // 而 SSRF 护栏的默认后缀表没有它 ⇒ 两个守卫对「企业内网域名」判定不一致。
    // 合一后 SSRF 护栏也拦 `.corp`（属**收紧**，已在 ssrfPolicy 注释里登记）。
    ['.localhost', '.local', '.internal', '.intranet', '.lan', '.corp'],
  );
  // 默认档解析结果必须是同一个对象引用（无配置 ⇒ 零成本、零漂移）
  assert.strictEqual(SsrfPolicy.resolveSsrfPolicy(undefined), DEFAULT_SSRF_POLICY);
  // 行为抽查：默认策略下元数据/内网域拦、私有 IPv4 放行（与历史一致）
  assert.strictEqual(SsrfGuard.inspectHost('169.254.169.254', {}).blocked, true);
  assert.strictEqual(SsrfGuard.inspectHost('db.internal', {}).blocked, true);
  // 私有 IPv4 的放行由 allowPrivate 决定（默认策略 defaultSsrfOptions() 放行，严格模式拦）
  assert.strictEqual(
    SsrfGuard.inspectHost('10.0.0.1', SsrfGuard.defaultSsrfOptions()).blocked,
    false,
  );
  assert.strictEqual(SsrfGuard.inspectHost('10.0.0.1', {}).blocked, true);
});

test('② 自定义策略表生效，且是**替换**语义（不静默合并）', () => {
  const policy = SsrfPolicy.resolveSsrfPolicy({
    metadataHosts: ['evil.example'],
    internalSuffixes: ['.corp'],
  });
  // 自定义项生效
  assert.strictEqual(SsrfGuard.inspectHost('evil.example', { policy }).blocked, true);
  assert.strictEqual(SsrfGuard.inspectHost('svc.corp', { policy }).blocked, true);
  // 未声明的默认项被**替换**掉：metadata.google.internal 不再拦（语义显式，文档已注明）
  assert.strictEqual(SsrfGuard.inspectHost('metadata.google.internal', { policy }).blocked, false);
  // 但 169.254.169.254 仍被 IPv4 网段表拦住（纵深防御：元数据地址不依赖主机名表）
  assert.strictEqual(SsrfGuard.inspectHost('169.254.169.254', { policy }).blocked, true);
});

test('②-2 自定义 IPv4 网段表生效（严格模式下判定）', () => {
  const policy = SsrfPolicy.resolveSsrfPolicy({ ipv4Blocks: [['203.0.113.0', 24]] });
  const strict = { allowPrivate: false, policy };
  assert.strictEqual(
    SsrfGuard.inspectHost('203.0.113.7', strict).blocked,
    true,
    '自定义网段应被拦',
  );
  // 默认表被替换 ⇒ 10/8 不在表内且 allowPrivate=false 时……仍会被 isPrivateIpv4 判为「不可解析」？
  // 不会：10.0.0.5 是合法 IPv4，只是不在用户重定义的网段表里 ⇒ 放行（替换语义的另一面，如实钉住）。
  assert.strictEqual(
    SsrfGuard.inspectHost('10.0.0.5', strict).blocked,
    false,
    '替换语义：默认网段不再生效',
  );
});

test('②-3 出站守卫同样受策略表驱动（与 SSRF 护栏同源）', () => {
  const policy = SsrfPolicy.resolveSsrfPolicy({ internalSuffixes: ['.corp'] });
  const guard = new NetworkEgressGuard({ allowedHosts: ['svc.corp'], policy });
  assert.throws(
    () => guard.assertAllowed('https://svc.corp/x'),
    /SSRF/,
    '自定义内网后缀应拦（白名单不可覆盖）',
  );
  // 未声明的默认后缀随替换失效
  const relaxed = new NetworkEgressGuard({
    allowedHosts: ['x.internal'],
    policy: SsrfPolicy.resolveSsrfPolicy({ internalSuffixes: [] }),
  });
  relaxed.assertAllowed('https://x.internal/ok');
});

test('③ 非法条目抛错（fail-closed，不静默丢弃）', () => {
  assert.throws(() => SsrfPolicy.resolveSsrfPolicy({ ipv4Blocks: [['10.0.0.0', 33]] }), /前缀长度/);
  assert.throws(
    () => SsrfPolicy.resolveSsrfPolicy({ ipv4Blocks: [['999.1.1.1', 8]] }),
    /非法网段地址/,
  );
  assert.throws(
    () => SsrfPolicy.resolveSsrfPolicy({ internalSuffixes: ['internal'] }),
    /必须以 "\." 开头/,
  );
  assert.throws(() => SsrfPolicy.resolveSsrfPolicy({ metadataHosts: ['  '] }), /非法主机/);
  assert.throws(() => SsrfPolicy.resolveSsrfPolicy({ metadataHosts: ['bad host'] }), /非法主机/);
});

test('③-2 显式空数组 = 清空该项（显式且危险，但不静默）', () => {
  const policy = SsrfPolicy.resolveSsrfPolicy({ metadataHosts: [] });
  assert.deepStrictEqual([...policy.metadataHosts], []);
  assert.strictEqual(
    SsrfGuard.inspectHost('metadata.goog', { policy }).blocked,
    false,
    '显式清空后元数据主机名不再拦',
  );
  // 注意 metadata.google.internal 仍会被 .internal 后缀拦住（后缀表未清空）——如实钉住：
  assert.strictEqual(SsrfGuard.inspectHost('metadata.google.internal', { policy }).blocked, true);
  // 但 ipv4 网段未声明 ⇒ 仍走默认档 ⇒ 169.254.169.254 依旧被拦
  assert.strictEqual(SsrfGuard.inspectHost('169.254.169.254', { policy }).blocked, true);
});

test('④ 配置段校验器与运行时解析器同源（同一份规则、同一批拒绝项）', () => {
  const asConfig = (ssrfPolicy: unknown): FileConfig => ({ ssrfPolicy }) as unknown as FileConfig;
  assert.strictEqual(ssrfPolicyValidator.validate(asConfig(undefined)), undefined);
  assert.strictEqual(
    ssrfPolicyValidator.validate(asConfig({ metadataHosts: ['evil.example'] })),
    undefined,
  );
  // 与 resolveSsrfPolicy 同一批拒绝项
  assert.match(
    String(ssrfPolicyValidator.validate(asConfig({ ipv4Blocks: [['10.0.0.0', 33]] }))),
    /前缀长度/,
  );
  assert.match(
    String(ssrfPolicyValidator.validate(asConfig({ internalSuffixes: ['internal'] }))),
    /必须以/,
  );
  // 结构与未知 key
  assert.match(String(ssrfPolicyValidator.validate(asConfig([]))), /应为对象/);
  assert.match(String(ssrfPolicyValidator.validate(asConfig({ nope: 1 }))), /未知 key/);
  assert.match(String(ssrfPolicyValidator.validate(asConfig({ metadataHosts: 'x' }))), /应为数组/);
});

test('⑤ 默认档来自数据文件（defaults/ssrf.json），不是代码里的第二份副本', () => {
  const file = join(repoRoot, 'defaults', 'ssrf.json');
  assert.ok(
    existsSync(file),
    `默认档数据文件必须随包发布（package.json#files 含 defaults）：${file}`,
  );
  const raw = JSON.parse(readFileSync(file, 'utf8')) as {
    metadataHosts: string[];
    internalSuffixes: string[];
    ipv4Blocks: (string | number)[][];
  };
  // 数据文件 ≡ 生效默认档：改数据即改行为，代码里不再有第二份需要同步的表。
  assert.deepStrictEqual(raw.metadataHosts, [...DEFAULT_SSRF_POLICY.metadataHosts]);
  assert.deepStrictEqual(raw.internalSuffixes, [...DEFAULT_SSRF_POLICY.internalSuffixes]);
  assert.deepStrictEqual(
    raw.ipv4Blocks,
    DEFAULT_SSRF_POLICY.ipv4Blocks.map(([base, bits]) => [base, bits]),
  );
});

test('⑤-2 数据文件缺失 / 坏 JSON 一律抛错（fail-closed，绝不退化成空表）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-defaults-'));
  const loader = new BuiltinDefaults(dir);
  assert.throws(() => loader.json('ssrf'), /内建默认数据缺失/);
  writeFileSync(join(dir, 'broken.json'), '{ not json', 'utf8');
  assert.throws(() => loader.json('broken'), /不是合法 JSON/);
  // 正常路径可读且被缓存（第二次不再走 IO）
  writeFileSync(join(dir, 'ok.json'), '{"a":1}', 'utf8');
  assert.deepStrictEqual(loader.json('ok'), { a: 1 });
  assert.deepStrictEqual(loader.json('ok'), { a: 1 });
});

test('⑤-3 包根定位：以 package.json 为锚，随包/源码两种布局都命中（不是写死级数）', () => {
  const root = mkdtempSync(join(tmpdir(), 'omni-root-'));
  const pkg = join(root, 'pkg');
  mkdirSync(join(pkg, 'defaults'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), '{"name":"x","files":["defaults"]}', 'utf8');
  writeFileSync(join(pkg, 'defaults', 'ssrf.json'), '{}', 'utf8');
  // 随包布局：dist/src/util → 向上 3 级
  const shipped = join(pkg, 'dist', 'src', 'util');
  mkdirSync(shipped, { recursive: true });
  assert.strictEqual(BuiltinDefaults.locatePackageRoot(shipped), join(pkg, 'defaults'));
  // 源码布局：src/util → 向上 2 级（旧实现写死 ../../.. 时会指到仓库父目录）
  const source = join(pkg, 'src', 'util');
  mkdirSync(source, { recursive: true });
  assert.strictEqual(BuiltinDefaults.locatePackageRoot(source), join(pkg, 'defaults'));
  // 只有 defaults/ 而无 package.json 的祖先不算包根（否则会静默读到别人的数据 = fail-open）
  const orphan = join(root, 'orphan');
  mkdirSync(join(orphan, 'defaults'), { recursive: true });
  mkdirSync(join(orphan, 'src', 'util'), { recursive: true });
  assert.throws(() => BuiltinDefaults.locatePackageRoot(join(orphan, 'src', 'util')), /定位包根/);
  // 向上有界：足够深的目录不会无限上溯
  const deep = join(root, 'a', 'b', 'c', 'd', 'e', 'f');
  mkdirSync(deep, { recursive: true });
  assert.throws(() => BuiltinDefaults.locatePackageRoot(deep), /定位包根/);
  // 最近者胜：嵌套包根取内层
  const inner = join(pkg, 'vendor', 'inner');
  mkdirSync(join(inner, 'defaults'), { recursive: true });
  writeFileSync(join(inner, 'package.json'), '{"name":"inner"}', 'utf8');
  mkdirSync(join(inner, 'src'), { recursive: true });
  assert.strictEqual(
    BuiltinDefaults.locatePackageRoot(join(inner, 'src')),
    join(inner, 'defaults'),
  );
  // 默认实例（真实仓库布局）必须解析成功，且能读到三份数据
  assert.deepStrictEqual(Object.keys(builtinDefaults.json('ssrf') as object).length > 0, true);
});

test('⑥ 配置化的 ipv4Blocks 对 IPv6 内嵌写法同样生效（口径修复回归）', () => {
  // 修前：`isPrivateIpv6` 的内嵌 IPv4 判定走的是**内置默认表**（函数默认参数），
  // 于是「配置了 ipv4Blocks」只对纯 IPv4 生效，`[::ffff:203.0.113.7]` 这类等价写法被静默绕过。
  const policy = SsrfPolicy.resolveSsrfPolicy({ ipv4Blocks: [['203.0.113.0', 24]] });
  const strict = { allowPrivate: false, policy };
  assert.strictEqual(
    SsrfGuard.inspectHost('[::ffff:203.0.113.7]', strict).blocked,
    true,
    '自定义网段须覆盖 IPv4-mapped 写法',
  );
  assert.strictEqual(
    SsrfGuard.inspectHost('::ffff:10.0.0.5', strict).blocked,
    false,
    '替换语义同样适用于 IPv6 内嵌路径：默认 10/8 不再生效',
  );
  // 默认档两条路径一致（纯 IPv4 与内嵌写法拦截面相同）
  assert.strictEqual(SsrfGuard.inspectHost('10.0.0.5', { allowPrivate: false }).blocked, true);
  assert.strictEqual(
    SsrfGuard.inspectHost('::ffff:10.0.0.5', { allowPrivate: false }).blocked,
    true,
  );
});

test('⑦ 配置文件里的 ssrfPolicy 真的到达 CLI 参数（修「声明未接线」）', () => {
  // 修前：`configDefaults` 从不映射 `file.ssrfPolicy` ⇒ `args.ssrfPolicy` 恒为 undefined，
  // 写在 omniharness.json 里的策略表从未到达出站守卫 / 组合根（只有编程 API 路径生效）。
  const declared: FileConfig = { ssrfPolicy: { metadataHosts: ['evil.example'] } };
  assert.deepStrictEqual(ArgParser.configDefaults(declared).ssrfPolicy, {
    metadataHosts: ['evil.example'],
  });
  // 未声明时不得凭空写入（保持「缺省 = 数据文件里的默认档」语义）
  assert.strictEqual(ArgParser.configDefaults({}).ssrfPolicy, undefined);
});

test('⑧ ssrfOptionsFor：注入策略时不丢默认档（防「只传 policy ⇒ 本地端点被拦」）', () => {
  const policy = SsrfPolicy.resolveSsrfPolicy({ internalSuffixes: ['.corp'] });
  const merged = SsrfGuard.ssrfOptionsFor(policy);
  // 默认档必须保留：否则 A2A 回环端点 / 本地 Ollama 会被误拦（2026-09-22 E2 装配回归形态）
  assert.strictEqual(merged.allowPrivate, SsrfGuard.defaultSsrfOptions().allowPrivate);
  assert.strictEqual(merged.allowMetadata, false);
  assert.strictEqual(merged.policy, policy);
  // 注入的策略生效：本地端点仍放行、自定义后缀被拦
  assert.strictEqual(SsrfGuard.inspectHost('localhost', merged).blocked, true, 'localhost 恒拦');
  assert.strictEqual(SsrfGuard.inspectHost('127.0.0.1', merged).blocked, false, '私有网段默认放行');
  assert.strictEqual(SsrfGuard.inspectHost('svc.corp', merged).blocked, true, '自定义后缀生效');
  // 不传策略 ⇒ 等价于默认档 + 默认表
  const bare = SsrfGuard.ssrfOptionsFor();
  assert.strictEqual(bare.policy, DEFAULT_SSRF_POLICY);
  assert.strictEqual(SsrfGuard.inspectHost('metadata.goog', bare).blocked, true);
});
