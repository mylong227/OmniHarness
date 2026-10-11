// 判据：QuotaStore（`<workspace>/.omniharness/quota.json`）的落盘契约。
//
// 覆盖的风险面：文件缺失 / 损坏 JSON / 字段非法的处置、写盘失败是否可见、父目录创建、
// 两次写的最终一致、读回与写入等值、运行期切换工作区。
//
// 纪律：
//  - 全部走**真实文件 IO**（mkdtempSync 临时工作区 + rmSync 清理），不 mock 被测的
//    readFileSync / writeFileSync / mkdirSync —— 连「读失败」「写失败」都用真实错误触发
//    （路径被目录占位 ⇒ EISDIR；父目录被同名文件占位 ⇒ EEXIST）；
//  - 每条判据旁标注「正对照」：说明改坏被测逻辑后它会在哪一步变红（另附实跑的红/绿证据）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuotaStore } from '../../src/server/services/quotaStore.js';

/** 缺省基础日预算（与 quotaStore.ts 的 DEFAULT_DAILY_TOKENS 对齐，独立写死以免同源同错）。 */
const DEFAULT_TOKENS = 1_000_000;

/** 配额文件相对工作区的路径。 */
const QUOTA_REL = join('.omniharness', 'quota.json');

/**
 * 在一次性临时工作区里跑用例，结束即删。
 * @param fn 用例体（接收工作区绝对路径）
 * @returns 用例体返回值
 */
function withWorkspace<T>(fn: (ws: string) => T): T {
  const ws = mkdtempSync(join(tmpdir(), 'omni-quota-'));
  try {
    return fn(ws);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

/**
 * 直接写一份原始配额文件（模拟「手改坏了」的盘上状态）。
 * @param ws 工作区绝对路径
 * @param text 文件原始文本
 * @returns 文件绝对路径
 */
function writeRaw(ws: string, text: string): string {
  const file = join(ws, QUOTA_REL);
  mkdirSync(join(ws, '.omniharness'), { recursive: true });
  writeFileSync(file, text, 'utf8');
  return file;
}

/**
 * 读回配额文件原始字节。
 * @param ws 工作区绝对路径
 * @returns 文件原始文本
 */
function readRaw(ws: string): string {
  return readFileSync(join(ws, QUOTA_REL), 'utf8');
}

test('QuotaStore：文件缺失 ⇒ 全字段缺省、不抛错、且只读不产生磁盘副作用', () => {
  withWorkspace((ws) => {
    const store = new QuotaStore(() => ws);
    assert.strictEqual(
      store.filePath(),
      join(ws, QUOTA_REL),
      'filePath 必须是 工作区 × .omniharness/quota.json',
    );
    // 正对照：若 readRaw 把「文件缺失」当异常抛出（典型退化实现），下一行立刻变红。
    assert.doesNotThrow(() => store.read());
    assert.deepStrictEqual(store.read(), { plan: 'free', dailyTokens: DEFAULT_TOKENS });
    assert.strictEqual(existsSync(join(ws, '.omniharness')), false, '只读不得顺手建目录');
  });
});

test('QuotaStore：档位非法/类型不对/缺失 ⇒ 该字段回退 free，另一字段不受牵连', () => {
  withWorkspace((ws) => {
    const store = new QuotaStore(() => ws);
    const cases: readonly string[] = [
      '{"plan":"enterprise","dailyTokens":123}', // 未登记档位
      '{"plan":"PRO","dailyTokens":123}', // 大小写不是同一档
      '{"plan":42,"dailyTokens":123}', // 类型不对
      '{"plan":null,"dailyTokens":123}',
      '{"plan":["free"],"dailyTokens":123}',
      '{"plan":true,"dailyTokens":123}',
      '{"dailyTokens":123}', // 字段缺失
    ];
    for (const text of cases) {
      writeRaw(ws, text);
      assert.deepStrictEqual(store.read(), { plan: 'free', dailyTokens: 123 }, text);
    }
    // 正对照：合法档位必须原样读出 —— 若 isValid 被改成恒 false（"总回退"型退化），
    // 上表照样全绿，而下面这条会红。
    writeRaw(ws, '{"plan":"pro","dailyTokens":123}');
    assert.deepStrictEqual(store.read(), { plan: 'pro', dailyTokens: 123 });
  });
});

test('QuotaStore：日预算 0/负数/非数/Infinity ⇒ 回退缺省；合法小数被 floor 而非回退', () => {
  withWorkspace((ws) => {
    const store = new QuotaStore(() => ws);
    const fallbackCases: readonly string[] = [
      '{"dailyTokens":0}',
      '{"dailyTokens":-1}',
      '{"dailyTokens":"100"}',
      '{"dailyTokens":null}',
      '{"dailyTokens":true}',
      '{"dailyTokens":[7]}',
    ];
    for (const text of fallbackCases) {
      writeRaw(ws, text);
      assert.strictEqual(store.read().dailyTokens, DEFAULT_TOKENS, text);
    }
    // JSON 里的 1e999 解析为 Infinity —— 这是 `!Number.isFinite` 分支在真实文件里的可达路径。
    writeRaw(ws, '{"dailyTokens":1e999}');
    assert.strictEqual(
      store.read().dailyTokens,
      DEFAULT_TOKENS,
      'Infinity 必须回退缺省（否则预算上限失去意义）',
    );
    // 正对照：合法小数走 Math.floor 而不是回退 —— 若把 floor 改成「非整数即回退」，本条变红。
    writeRaw(ws, '{"dailyTokens":1.9}');
    assert.strictEqual(store.read().dailyTokens, 1);
  });
});

test('QuotaStore：损坏 JSON / 非对象 JSON 一律静默按缺省处置（不抛错、不改写磁盘）——现状如实断言', () => {
  withWorkspace((ws) => {
    const store = new QuotaStore(() => ws);
    const broken: readonly string[] = [
      '{ not json',
      '{"plan":"pro",}',
      '', // 空文件
      'null',
      '[{"plan":"pro","dailyTokens":9}]', // 数组
      '42',
      '"pro"',
      'true',
    ];
    for (const text of broken) {
      const file = writeRaw(ws, text);
      // 正对照：把 readRaw 的 catch 改为 rethrow（"坏文件就报错"型实现），本条立刻变红。
      assert.deepStrictEqual(
        store.read(),
        { plan: 'free', dailyTokens: DEFAULT_TOKENS },
        JSON.stringify(text),
      );
      assert.strictEqual(readFileSync(file, 'utf8'), text, '读失败不得顺手改写磁盘');
    }
  });
});

test('QuotaStore：文件存在但读不了（路径是目录 ⇒ 真实 EISDIR）⇒ 同样回退缺省而不是崩', () => {
  withWorkspace((ws) => {
    mkdirSync(join(ws, QUOTA_REL), { recursive: true });
    const store = new QuotaStore(() => ws);
    // 正对照：readFileSync 的 EISDIR 若不被 catch 兜住，这里抛出的是 EISDIR 而不是缺省值。
    assert.deepStrictEqual(store.read(), { plan: 'free', dailyTokens: DEFAULT_TOKENS });
  });
});

test('QuotaStore：write 递归建父目录、落盘字节固定（缩进 2 + 结尾换行）、读回等值', () => {
  withWorkspace((ws) => {
    const root = join(ws, 'deep', 'nested'); // 整条父目录链都不存在
    const store = new QuotaStore(() => root);
    const saved = store.write({ plan: 'pro', dailyTokens: 7 });
    assert.deepStrictEqual(saved, { plan: 'pro', dailyTokens: 7 }, '返回值即落盘值');
    assert.deepStrictEqual(store.read(), saved, '写入后读回必须等值');
    // 正对照：若 write 退化成 `JSON.stringify(next)`（无缩进/无换行），本条立刻变红。
    assert.strictEqual(readRaw(root), '{\n  "plan": "pro",\n  "dailyTokens": 7\n}\n');
    assert.ok(existsSync(join(root, '.omniharness')), '父目录必须被递归创建');
  });
});

test('QuotaStore：write 是局部更新（未提供的字段保持磁盘现值），空 patch 不得清零', () => {
  withWorkspace((ws) => {
    const store = new QuotaStore(() => ws);
    store.write({ plan: 'pro', dailyTokens: 2000 });
    assert.deepStrictEqual(store.write({ plan: 'plus' }), { plan: 'plus', dailyTokens: 2000 });
    assert.deepStrictEqual(store.write({ dailyTokens: 5 }), { plan: 'plus', dailyTokens: 5 });
    // 正对照：若 write 把「未提供字段」当 undefined 直接落盘（或用空对象覆盖），本条变红。
    assert.deepStrictEqual(store.write({}), { plan: 'plus', dailyTokens: 5 });
    assert.deepStrictEqual(store.read(), { plan: 'plus', dailyTokens: 5 });
  });
});

test('QuotaStore：两个实例各自读-改-写 ⇒ 合并基准是磁盘现值而非各自内存快照', () => {
  withWorkspace((ws) => {
    const a = new QuotaStore(() => ws);
    const b = new QuotaStore(() => ws);
    a.write({ plan: 'pro', dailyTokens: 111 });
    b.write({ dailyTokens: 222 }); // b 从未见过 a 的内存态
    // 正对照：若 write 在实例内缓存 current（构造函数里读一次），这里会得到 plan=free。
    assert.deepStrictEqual(a.read(), { plan: 'pro', dailyTokens: 222 });
    assert.deepStrictEqual(b.read(), { plan: 'pro', dailyTokens: 222 });
  });
});

test('QuotaStore：非法档位/非法日预算被拒（fail-closed），且磁盘零改动、目录里无半成品', () => {
  withWorkspace((ws) => {
    const store = new QuotaStore(() => ws);
    // (a) 全新工作区：非法写必须完全不落盘（连目录都不该建）。
    assert.throws(() => store.write({ plan: 'enterprise' }), /未知配额档位: enterprise/);
    assert.throws(() => store.write({ plan: '' }), /未知配额档位: /);
    assert.throws(() => store.write({ dailyTokens: 0 }), /日预算必需为正数/);
    assert.throws(() => store.write({ dailyTokens: -1 }), /日预算必需为正数/);
    assert.throws(() => store.write({ dailyTokens: Number.NaN }), /日预算必需为正数/);
    assert.throws(() => store.write({ dailyTokens: Number.POSITIVE_INFINITY }), /日预算必需为正数/);
    assert.strictEqual(existsSync(join(ws, QUOTA_REL)), false, '被拒的写不得留下文件');
    // (b) 已有合法内容：非法写必须逐字节保持原文件（先写后校验的实现会在这里变红）。
    store.write({ plan: 'pro', dailyTokens: 9 });
    const before = readRaw(ws);
    assert.throws(() => store.write({ plan: 'enterprise' }), /未知配额档位/);
    assert.throws(() => store.write({ plan: 'pro', dailyTokens: -5 }), /日预算必需为正数/);
    assert.strictEqual(readRaw(ws), before, '非法写不得改动磁盘');
    // (c) 目录里只有配额文件本身：既不 tmp+rename（会留 .tmp），也不多文件追加。
    assert.deepStrictEqual(readdirSync(join(ws, '.omniharness')), ['quota.json']);
    assert.deepStrictEqual(store.read(), { plan: 'pro', dailyTokens: 9 });
  });
});

test('QuotaStore：write 把小数日预算 floor 后落盘（内存返回值与磁盘字节一致）', () => {
  withWorkspace((ws) => {
    const store = new QuotaStore(() => ws);
    assert.deepStrictEqual(store.write({ dailyTokens: 12.9 }), { plan: 'free', dailyTokens: 12 });
    // 正对照：若 write 只 floor 返回值却把 12.9 落盘（或反之），内存与磁盘立刻不等值。
    assert.strictEqual(readRaw(ws), '{\n  "plan": "free",\n  "dailyTokens": 12\n}\n');
    assert.deepStrictEqual(store.read(), { plan: 'free', dailyTokens: 12 });
  });
});

test('QuotaStore：同一 tick 内连续三次写 ⇒ 末次胜，文件始终是单段完整 JSON、无残留', () => {
  withWorkspace((ws) => {
    const store = new QuotaStore(() => ws);
    // 诚实边界：write 内部是同步的 writeFileSync，两次调用之间**不可能**交错 ⇒ 真并发交错不可达；
    // 本判据锁的是「可观测结果」：末次胜 + 文件始终可整体解析 + 不留临时文件。
    const results = [
      store.write({ plan: 'pro', dailyTokens: 1 }),
      store.write({ plan: 'free', dailyTokens: 2 }),
      store.write({ plan: 'plus', dailyTokens: 3 }),
    ];
    assert.deepStrictEqual(results[2], { plan: 'plus', dailyTokens: 3 });
    const text = readRaw(ws);
    // 正对照：若 write 用追加（`flag:'a'`）而不是覆盖写，这里 JSON.parse 会因多段 JSON 抛错。
    assert.deepStrictEqual(JSON.parse(text), { plan: 'plus', dailyTokens: 3 });
    assert.strictEqual(text, '{\n  "plan": "plus",\n  "dailyTokens": 3\n}\n');
    assert.deepStrictEqual(
      readdirSync(join(ws, '.omniharness')),
      ['quota.json'],
      '不得留 tmp 残留',
    );
    assert.deepStrictEqual(store.read(), { plan: 'plus', dailyTokens: 3 });
  });
});

test('QuotaStore：workspaceRoot getter 每次调用都重新求值（运行期切项目不得复用旧路径）', () => {
  withWorkspace((wsA) => {
    const wsB = join(wsA, 'other-project');
    mkdirSync(wsB, { recursive: true });
    let root = wsA;
    const store = new QuotaStore(() => root);
    store.write({ plan: 'pro', dailyTokens: 42 });
    root = wsB;
    assert.strictEqual(store.filePath(), join(wsB, QUOTA_REL));
    // 正对照：若构造函数把路径读一次固化进字段，这里会读到 A 的 pro/42。
    assert.deepStrictEqual(store.read(), { plan: 'free', dailyTokens: DEFAULT_TOKENS });
    assert.strictEqual(existsSync(join(wsB, QUOTA_REL)), false, '切项目后不得写进 B');
    // 反向对照：原工作区内容原样保留（不是"切走就清空"）。
    assert.deepStrictEqual(new QuotaStore(() => wsA).read(), { plan: 'pro', dailyTokens: 42 });
  });
});

test('QuotaStore：未知字段被忽略，且写回时被丢弃（现状：落盘只有 plan/dailyTokens）', () => {
  withWorkspace((ws) => {
    writeRaw(ws, '{"plan":"pro","dailyTokens":5,"note":"手改追加的字段"}');
    const store = new QuotaStore(() => ws);
    // 正对照：若 read 直接回传 readRaw 的原始对象，下方 keys 断言会多出 note ⇒ 变红。
    assert.deepStrictEqual(store.read(), { plan: 'pro', dailyTokens: 5 });
    store.write({ dailyTokens: 6 });
    assert.deepStrictEqual(Object.keys(JSON.parse(readRaw(ws)) as object).sort(), [
      'dailyTokens',
      'plan',
    ]);
  });
});

test('QuotaStore：写盘失败如实上抛（quota.json 被目录占位 ⇒ 真实 EISDIR）', () => {
  withWorkspace((ws) => {
    mkdirSync(join(ws, QUOTA_REL), { recursive: true });
    const store = new QuotaStore(() => ws);
    // 正对照：若 write 把 writeFileSync 包进 try/catch 静默吞掉（"写失败也算成功"型实现），
    // assert.throws 立刻变红 —— 用户明确改了设置却没落盘必须可见。
    assert.throws(
      () => store.write({ plan: 'pro' }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'EISDIR',
    );
  });
});

test('QuotaStore：父目录被同名文件占位 ⇒ mkdirSync 真实失败并上抛（EEXIST），不静默降级', () => {
  withWorkspace((ws) => {
    writeFileSync(join(ws, '.omniharness'), 'not a directory', 'utf8');
    const store = new QuotaStore(() => ws);
    // 正对照：若 write 忽略 mkdirSync 的失败继续写（或用 `mkdirSync(...,{recursive:true})` 的
    // 返回值当成功），错误会被吞掉、磁盘状态变得不可解释 ⇒ 本条变红。
    assert.throws(
      () => store.write({ plan: 'pro' }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'EEXIST',
    );
    assert.strictEqual(
      readFileSync(join(ws, '.omniharness'), 'utf8'),
      'not a directory',
      '占位文件不得被改写',
    );
  });
});
