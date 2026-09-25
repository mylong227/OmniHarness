import assert from 'node:assert/strict';
import { describe, it, after } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileLongTermMemory } from '../../src/adapters/memory/fileLongTermMemory.js';
import { AesGcmTextCodec } from '../../src/adapters/memory/aesGcmTextCodec.js';
import { TimeDecay } from '../../src/adapters/memory/timeDecay.js';
import type { MemoryFact } from '../../src/ports/memory/longTermMemory.js';

// 临时目录在模块加载期急切创建（不可放进 before() 钩子）：钩子若在部分运行器/版本下
// 未执行或失败，dir 会保持空串，tmpFile 退化为相对路径——测试产物（含 .key/.enc）会
// 静默喷进进程 cwd。急切创建让失败在装载期即响亮暴露，且 tmpFile 恒为绝对路径。
const dir = mkdtempSync(join(tmpdir(), 'ltm-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function tmpFile(name: string): string {
  return join(dir, name);
}

function fact(over: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: 'f-' + Math.random().toString(36).slice(2),
    text: '用户偏好暗色主题',
    topic: '偏好',
    importance: 4,
    createdAt: new Date().toISOString(),
    sessionId: 's1',
    source: 'tool',
    ...over,
  };
}

describe('FileLongTermMemory（明文）', () => {
  it('remember / all / count 闭环', () => {
    const m = new FileLongTermMemory(tmpFile('a.jsonl'));
    assert.strictEqual(m.count, 0);
    m.remember(fact({ id: 'a', text: '禁用第三方 npm 依赖' }));
    m.remember(fact({ id: 'b', text: 'TS 文件用 camelCase' }));
    assert.strictEqual(m.count, 2);
    assert.strictEqual(m.all().length, 2);
    assert.ok(readFileSync(tmpFile('a.jsonl'), 'utf8').includes('禁用第三方 npm 依赖'));
  });

  it('get / update / delete（重写持久化）', () => {
    const m = new FileLongTermMemory(tmpFile('b.jsonl'));
    m.remember(fact({ id: 'a', text: '旧事实', importance: 2 }));
    assert.strictEqual(m.update('a', { text: '新事实', importance: 5 }), true);
    const got = m.get('a');
    assert.ok(got !== undefined);
    assert.strictEqual(got!.text, '新事实');
    assert.strictEqual(got!.importance, 5);
    assert.strictEqual(m.delete('nope'), false);
    assert.strictEqual(m.delete('a'), true);
    assert.strictEqual(m.get('a'), undefined);
    assert.strictEqual(m.count, 0);
  });

  it('reloads after re-open (cross-session persistence)', () => {
    const p = tmpFile('c.jsonl');
    const m1 = new FileLongTermMemory(p);
    m1.remember(fact({ id: 'x', text: 'PMS bug 5135058 根因是抽面颜色矩阵被覆盖' }));
    const m2 = new FileLongTermMemory(p);
    assert.strictEqual(m2.count, 1);
    assert.strictEqual(m2.get('x')?.text, 'PMS bug 5135058 根因是抽面颜色矩阵被覆盖');
  });

  it('skips corrupted lines on load without crashing', () => {
    const p = tmpFile('d.jsonl');
    const m = new FileLongTermMemory(p);
    m.remember(fact({ id: 'ok', text: '好事实' }));
    appendFileSync(p, '这不是合法JSON\n');
    const reloaded = new FileLongTermMemory(p);
    assert.strictEqual(reloaded.count, 1);
    assert.strictEqual(reloaded.get('ok')?.text, '好事实');
  });
});

describe('FileLongTermMemory（AES-256-GCM 加密 #4.4）', () => {
  it('落盘为密文，同密钥实例可还原', () => {
    const p = tmpFile('e.enc');
    const key = tmpFile('e.key');
    const store = new FileLongTermMemory(p, new AesGcmTextCodec({ keyFile: key }));
    store.remember(fact({ id: 's', text: '敏感约定：API 密钥轮换周期 30 天' }));
    const raw = readFileSync(p, 'utf8');
    assert.ok(!raw.includes('敏感约定'), '落盘内容不应是明文');
    assert.ok(raw.includes(':'), '应为 iv:cipher:tag 格式');
    const reloaded = new FileLongTermMemory(p, new AesGcmTextCodec({ keyFile: key }));
    assert.strictEqual(reloaded.get('s')?.text, '敏感约定：API 密钥轮换周期 30 天');
  });

  it('不同密钥无法还原（GCM auth 失败计为 0 条）', () => {
    const p = tmpFile('f.enc');
    const k1 = tmpFile('f1.key');
    const k2 = tmpFile('f2.key');
    const store = new FileLongTermMemory(p, new AesGcmTextCodec({ keyFile: k1 }));
    store.remember(fact({ id: 't', text: '机密事实' }));
    const wrong = new FileLongTermMemory(p, new AesGcmTextCodec({ keyFile: k2 }));
    assert.strictEqual(wrong.count, 0);
  });

  it('加密实例支持 get/update/delete 并跨实例一致', () => {
    const p = tmpFile('g.enc');
    const key = tmpFile('g.key');
    const store = new FileLongTermMemory(p, new AesGcmTextCodec({ keyFile: key }));
    store.remember(fact({ id: 'e', text: '待编辑', importance: 1 }));
    assert.strictEqual(store.update('e', { text: '已编辑', importance: 5 }), true);
    assert.strictEqual(store.get('e')?.text, '已编辑');
    assert.strictEqual(store.delete('e'), true);
    assert.strictEqual(store.get('e'), undefined);
    const reloaded = new FileLongTermMemory(p, new AesGcmTextCodec({ keyFile: key }));
    assert.strictEqual(reloaded.count, 0);
  });
});

describe('FileLongTermMemory（T3.1 时间维度：衰减召回 + 失效丢弃 + Ghost Memory）', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.parse('2026-09-12T00:00:00.000Z');

  it('同等相关性下较新事实胜出（文件移动重排期旧事实不压新事实）', () => {
    const m = new FileLongTermMemory(tmpFile('t1.jsonl'), undefined, 30, () => NOW);
    m.remember(
      fact({
        id: 'old',
        text: 'build config location is at old path',
        createdAt: new Date(NOW - 400 * DAY).toISOString(),
      }),
    );
    m.remember(
      fact({
        id: 'new',
        text: 'build config location is at new path',
        createdAt: new Date(NOW - 1 * DAY).toISOString(),
      }),
    );
    const hits = m.recall('build config location', 2);
    assert.strictEqual(hits.length, 2);
    assert.strictEqual(hits[0]!.id, 'new');
    assert.strictEqual(hits[1]!.id, 'old');
  });

  it('expiresAt 到点后 recall 丢弃', () => {
    const m = new FileLongTermMemory(tmpFile('t2.jsonl'), undefined, 90, () => NOW);
    m.remember(
      fact({ id: 'fresh', text: 'still valid fact', createdAt: new Date(NOW - DAY).toISOString() }),
    );
    m.remember({
      ...fact({
        id: 'stale',
        text: 'expired fact',
        createdAt: new Date(NOW - 10 * DAY).toISOString(),
      }),
      expiresAt: new Date(NOW - 5 * DAY).toISOString(),
    });
    const ids = m.recall('fact', 10).map((h) => h.id);
    assert.ok(ids.includes('fresh'));
    assert.ok(!ids.includes('stale'));
  });

  it('decayFactor：越旧衰减越多，非法/过期时间不衰减', () => {
    // 年龄近 0 → 衰减≈1（精确）
    assert.ok(Math.abs(TimeDecay.decayFactor(new Date(NOW).toISOString(), NOW, 30) - 1) < 1e-9);
    // 400 天（13+ 个半衰期）→ 衰减 < 1e-3
    assert.ok(TimeDecay.decayFactor(new Date(NOW - 400 * DAY).toISOString(), NOW, 30) < 1e-3);
    // 非法时间 → 不衰减
    assert.strictEqual(TimeDecay.decayFactor('not-a-date', NOW, 30), 1);
  });

  it('rankWithDecay：失效事实过滤 + 同分按年龄降序', () => {
    const oldAt = new Date(NOW - 400 * DAY).toISOString();
    const newAt = new Date(NOW - 1 * DAY).toISOString();
    const items = [
      { fact: fact({ id: 'old', text: 'x', createdAt: oldAt }), score: 10 },
      { fact: fact({ id: 'new', text: 'x', createdAt: newAt }), score: 10 },
      {
        fact: {
          ...fact({ id: 'exp', text: 'x', createdAt: newAt }),
          expiresAt: new Date(NOW - 5 * DAY).toISOString(),
        },
        score: 100,
      },
    ];
    const ranked = TimeDecay.rankWithDecay(items, NOW, 30, 10);
    assert.deepStrictEqual(
      ranked.map((f) => f.id),
      ['new', 'old'],
    );
  });
});
