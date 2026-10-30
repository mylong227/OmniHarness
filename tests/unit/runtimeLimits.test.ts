/**
 * 运维限制**数据化**判据（2026-10-30，用户指令「把能配置化的硬编码改成配置数据」）。
 *
 * ## 被改的形态
 *
 * `HttpServer` 构造函数里写死 `headersTimeout = 30_000` / `requestTimeout = 60_000` /
 * `maxConnections = 2048`、`MAX_BODY_BYTES = 8 * 1024 * 1024`、静态缓存 64 条 / 64 MiB，
 * 预览源另有一份 15s / 30s / 64。它们全是**部署环境相关**的运维旋钮（慢网络要放宽收头时限、
 * 被扫要收紧连接数、大附件要抬请求体上限），却只能改代码重发。
 *
 * 现收成一条链：`defaults/limits.json`（出厂值 + env 名）→ `omniharness.json` 的 `limits` 段
 * → 环境变量 → 消费者。
 *
 * ## 判据盯什么
 *
 * | # | 判据 | 坏掉的后果 |
 * | --- | --- | --- |
 * | ① | 出厂值与历史字面量**逐项一致** | 数据化改了默认行为（零配置用户被静默改口径） |
 * | ② | 环境变量能覆盖；空白视为未设置 | 「设了环境变量却没生效」 |
 * | ③ | 配置 > 环境变量 > 出厂值；未写的键继续走下层 | 优先级写反 = 用户配置被环境变量顶掉 |
 * | ④ | 坏值 fail-closed（坏 env 点名变量、越界拒绝） | 写错却静默用默认值，最难查 |
 * | ⑤ | 配置段校验：未知段/未知键/非整数/越界 | 配置写了不生效 |
 * | ⑥ | 数据文件缺键 / 未知键 / env 重名一律构造期抛错 | 缺数据静默退化 |
 * | ⑦ | 消费者**真读**（构造 HttpServer 后连接级参数就是配置值） | 声明未接线 |
 * | ⑧ | 反硬编码守卫：这些字面量不得再出现在消费者代码行里 | 迁移被回滚成两处真相 |
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';

import { HttpBridgeTransport, HttpServer } from '../../src/server/transport/httpServer.ts';
import type { AppServer } from '../../src/server/core/appServer.ts';
import { RuntimeLimits, runtimeLimits } from '../../src/util/runtimeLimits.ts';

/** 仓库根（判据在 dist/tests/unit，按 cwd 解析）。 */
const ROOT = process.cwd();

/** 读数据文件原文（每次返回独立解析结果，便于就地篡改做负例）。 */
function rawLimitsData(): Record<string, Record<string, Record<string, unknown>>> {
  return JSON.parse(readFileSync(join(ROOT, 'defaults', 'limits.json'), 'utf8')) as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
}

/**
 * 剥掉整行注释（行注释 / JSDoc 续行 / 块注释起始）——文档里提到旧字面量是合法的，代码里写死才是回归。
 * @param text 源码全文
 * @returns 去注释后的文本
 */
function stripComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
    })
    .join('\n');
}

/** 读 src 下某文件的代码行（已剥注释）。 */
function srcCode(rel: string): string {
  return stripComments(readFileSync(join(ROOT, rel), 'utf8'));
}

test('① 出厂值与历史字面量逐项一致（零配置行为不变）', () => {
  const defaults = runtimeLimits.defaults();
  assert.deepStrictEqual(defaults.http, {
    headersTimeoutMs: 30_000,
    requestTimeoutMs: 60_000,
    maxConnections: 2048,
    maxBodyBytes: 8 * 1024 * 1024,
    staticCacheMaxEntries: 64,
    staticCacheMaxBytes: 64 * 1024 * 1024,
  });
  assert.deepStrictEqual(defaults.preview, {
    headersTimeoutMs: 15_000,
    requestTimeoutMs: 30_000,
    maxConnections: 64,
  });
  // A2A 段（P2 迁入）：调用超时 60s / webhook 10s / 页大小 50 / 游标 TTL 24h——迁移前逐字写死。
  assert.deepStrictEqual(defaults.a2a, {
    clientTimeoutMs: 60_000,
    webhookTimeoutMs: 10_000,
    pageSize: 50,
    pageTokenTtlMs: 24 * 60 * 60 * 1000,
  });
});

test('② 环境变量覆盖生效；空白视为未设置', () => {
  const env = {
    OMNI_HTTP_HEADERS_TIMEOUT_MS: '45000',
    OMNI_HTTP_MAX_BODY_BYTES: '1048576',
    OMNI_PREVIEW_MAX_CONNECTIONS: '8',
    OMNI_HTTP_REQUEST_TIMEOUT_MS: '   ',
  };
  const resolved = runtimeLimits.resolve({}, env);
  assert.strictEqual(resolved.http.headersTimeoutMs, 45_000);
  assert.strictEqual(resolved.http.maxBodyBytes, 1_048_576);
  assert.strictEqual(resolved.preview.maxConnections, 8);
  // 空白 / 未设置 ⇒ 出厂值（不是 0、不是 NaN）。
  assert.strictEqual(resolved.http.requestTimeoutMs, 60_000);
  assert.strictEqual(resolved.http.maxConnections, 2048);
});

test('③ 优先级：配置 > 环境变量 > 出厂值；未写的键继续往下走', () => {
  const env = { OMNI_HTTP_MAX_CONNECTIONS: '500', OMNI_HTTP_STATIC_CACHE_MAX_ENTRIES: '128' };
  const resolved = runtimeLimits.resolve(
    { http: { maxConnections: 99, headersTimeoutMs: 12_000 } },
    env,
  );
  // 配置覆盖了 maxConnections ⇒ 环境变量的 500 不生效。
  assert.strictEqual(resolved.http.maxConnections, 99);
  // 配置没写 staticCacheMaxEntries ⇒ 用环境变量的 128。
  assert.strictEqual(resolved.http.staticCacheMaxEntries, 128);
  // 配置与环境都没写 ⇒ 出厂值。
  assert.strictEqual(resolved.http.requestTimeoutMs, 60_000);
  // 配置写了 headersTimeoutMs ⇒ 覆盖出厂 30000。
  assert.strictEqual(resolved.http.headersTimeoutMs, 12_000);
  // A2A 段同样逐键覆盖（配置 > 出厂），未写的键不动。
  const a2a = runtimeLimits.resolve({ a2a: { pageSize: 20 } }).a2a;
  assert.strictEqual(a2a.pageSize, 20);
  assert.strictEqual(a2a.clientTimeoutMs, 60_000);
});

test('④ 坏值 fail-closed：坏环境变量点名变量，越界拒绝（不静默回落）', () => {
  assert.throws(
    () => runtimeLimits.resolve({}, { OMNI_HTTP_REQUEST_TIMEOUT_MS: 'abc' }),
    /OMNI_HTTP_REQUEST_TIMEOUT_MS/u,
    '非整数环境变量必须点名变量报错，而不是静默用默认值',
  );
  assert.throws(() => runtimeLimits.resolve({}, { OMNI_HTTP_MAX_CONNECTIONS: '0' }), /之间/u);
  assert.throws(() => runtimeLimits.resolve({ http: { headersTimeoutMs: 1.5 } }), /整数/u);
  assert.throws(() => runtimeLimits.resolve({ http: { maxBodyBytes: 10 } }), /1024/u);
  // 正对照：合法覆盖不抛错，且真的生效（否则上面全是恒真通过）。
  assert.strictEqual(
    runtimeLimits.resolve({ http: { maxBodyBytes: 4096 } }).http.maxBodyBytes,
    4096,
  );
});

test('⑤ 配置段校验：未知段 / 未知键 / 非整数 / 越界都拒绝', () => {
  assert.strictEqual(RuntimeLimits.validateConfig(undefined), undefined);
  assert.strictEqual(
    RuntimeLimits.validateConfig({ http: { headersTimeoutMs: 45_000 } }),
    undefined,
  );
  assert.match(String(RuntimeLimits.validateConfig({ nope: {} })), /未知段/u);
  assert.match(
    String(RuntimeLimits.validateConfig({ http: { requestTimeout: 1000 } })),
    /未知 key/u,
  );
  assert.match(
    String(RuntimeLimits.validateConfig({ http: { headersTimeoutMs: '30000' } })),
    /整数/u,
  );
  assert.match(
    String(RuntimeLimits.validateConfig({ preview: { maxConnections: 999_999_999 } })),
    /之间/u,
  );
  // 正对照：非法输入必须返回**消息**（不是恒 undefined）。
  assert.notStrictEqual(
    RuntimeLimits.validateConfig({ http: { headersTimeoutMs: -1 } }),
    undefined,
  );
});

test('⑥ 数据文件缺键 / 未知键 / env 重名：构造期抛错（随包缺数据必须响）', () => {
  const good = rawLimitsData();
  assert.doesNotThrow(() => new RuntimeLimits(good), '原始数据必须合法');

  const missing = rawLimitsData();
  const missingHttp = missing['http']!;
  delete missingHttp['maxBodyBytes'];
  assert.throws(() => new RuntimeLimits(missing), /缺少|缺失/u);

  const unknown = rawLimitsData();
  unknown['http']!['maxBodyBytes'] = { value: 1024, env: 'OMNI_HTTP_MAX_BODY_BYTES' };
  unknown['http']!['maxBodyBytesExtra'] = { value: 1, env: 'OMNI_EXTRA_X' };
  assert.throws(() => new RuntimeLimits(unknown), /未知键/u);

  const duplicated = rawLimitsData();
  duplicated['preview']!['maxConnections'] = {
    value: 64,
    env: 'OMNI_HTTP_MAX_CONNECTIONS',
  };
  assert.throws(() => new RuntimeLimits(duplicated), /重复使用环境变量/u);

  const badEntry = rawLimitsData();
  badEntry['http']!['maxConnections'] = { value: 2048.5, env: 'OMNI_HTTP_MAX_CONNECTIONS' };
  assert.throws(() => new RuntimeLimits(badEntry), /整数/u);
});

test('⑦ 消费者真读：HttpServer 的连接级参数就是解析后的配置值', () => {
  const make = (limits?: Parameters<typeof runtimeLimits.resolve>[0]): HttpServer =>
    new HttpServer({
      app: {} as AppServer,
      bridge: new HttpBridgeTransport(),
      webDir: ROOT,
      ...(limits !== undefined ? { limits } : {}),
    });
  /** 摸私有字段（构造函数赋值的仪器自证；字段名变化时本判据当场红，属预期）。 */
  const rawServer = (
    server: HttpServer,
  ): { headersTimeout: number; requestTimeout: number; maxConnections: number } =>
    (
      server as unknown as {
        server: { headersTimeout: number; requestTimeout: number; maxConnections: number };
      }
    ).server;

  const byDefault = rawServer(make());
  assert.strictEqual(byDefault.headersTimeout, 30_000);
  assert.strictEqual(byDefault.requestTimeout, 60_000);
  assert.strictEqual(byDefault.maxConnections, 2048);

  const overridden = rawServer(make({ http: { headersTimeoutMs: 11_111, maxConnections: 7 } }));
  assert.strictEqual(overridden.headersTimeout, 11_111);
  assert.strictEqual(overridden.maxConnections, 7);
  // 未覆盖的键保持默认（逐键覆盖，不是整段替换）。
  assert.strictEqual(overridden.requestTimeout, 60_000);
});

test('⑧ 反硬编码守卫：这些字面量不得再出现在消费者代码行里', () => {
  const http = srcCode('src/server/transport/httpServer.ts');
  for (const pattern of [
    /30_000/u,
    /60_000/u,
    /\b2048\b/u,
    /8 \* 1024 \* 1024/u,
    /MAX_BODY_BYTES/u,
  ]) {
    assert.doesNotMatch(
      http,
      pattern,
      `httpServer.ts 不得再写死 ${String(pattern)}（应走 limits.http / defaults/limits.json）`,
    );
  }
  const preview = srcCode('src/server/transport/previewServer.ts');
  for (const pattern of [/15_000/u, /30_000/u, /maxConnections = 64/u]) {
    assert.doesNotMatch(preview, pattern, `previewServer.ts 不得再写死 ${String(pattern)}`);
  }
  // 正对照：消费者确实通过 limits 取值（否则"字面量没了"可能只是删了代码）。
  assert.match(http, /this\.limits\.http\.headersTimeoutMs/u);
  assert.match(http, /this\.limits\.http\.maxBodyBytes/u);
  assert.match(preview, /limits\.headersTimeoutMs/u);

  // A2A 段（P2）：三个消费者各自不得再写死迁移前的字面量。
  const a2aClient = srcCode('src/a2a/a2aClient.ts');
  assert.doesNotMatch(a2aClient, /60_000/u, 'a2aClient.ts 的调用超时必须走 limits.a2a');
  assert.match(a2aClient, /runtimeLimits\.defaults\(\)\.a2a\.clientTimeoutMs/u);
  const push = srcCode('src/a2a/a2aPushNotifications.ts');
  assert.doesNotMatch(push, /DEFAULT_WEBHOOK_TIMEOUT_MS/u);
  assert.match(push, /a2a\.webhookTimeoutMs/u);
  const pager = srcCode('src/a2a/a2aTaskPager.ts');
  assert.doesNotMatch(pager, /DEFAULT_PAGE_SIZE|DEFAULT_TTL_MS|24 \* 60 \* 60/u);
  assert.match(pager, /a2aDefaults\.pageSize/u);
});

test('⑨ 接线：配置文件 → CLI → 装配 → 消费者 四段都在', () => {
  assert.match(srcCode('src/cli/argParser.ts'), /result\.limits = file\.limits/u);
  assert.match(
    srcCode('src/cli/cliSubsystemSections.ts'),
    /args\.limits !== undefined \? \{ limits: args\.limits \}/u,
  );
  assert.match(srcCode('src/config/configFactory.ts'), /limits: partial\.limits/u);
  assert.match(srcCode('src/cli/cliServerCmds.ts'), /limits: config\.limits/u);
  assert.match(
    srcCode('src/ports/config/fileConfig.ts'),
    /readonly limits\?: RuntimeLimitsConfig/u,
  );
  // A2A 消费点：组合根把解析后的 limits 交给 client / pager / push。
  const runtime = srcCode('src/composition/runtime.ts');
  assert.match(runtime, /runtimeLimits\.resolve\(config\.limits\)\.a2a/u);
  assert.match(runtime, /new A2aTaskPager\(\{/u);
  assert.match(runtime, /new A2aPushNotifications\(\{ timeoutMs/u);
  assert.match(runtime, /timeoutMs: a2aLimits\.clientTimeoutMs/u);
});
