import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileLongTermMemory } from '../../src/adapters/memory/fileLongTermMemory.js';
import { AesGcmTextCodec } from '../../src/adapters/memory/aesGcmTextCodec.js';
import type { MemoryFact } from '../../src/ports/longTermMemory.js';

let dir = '';
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'ltm-'));
});
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
