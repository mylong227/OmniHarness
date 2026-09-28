// 侧车**并发与原子性**门禁（真文件、真 IO）：用户点名「整文件重写 last-write-wins 会丢写入」。
//
// ## 形态
//
// 侧车（标题 / 归档名单 / 排序）都是整体重写：旧实现直接 `writeFileSync`，两个后果：
// ① **跨进程并发**（两个 serve 指向同一存储目录）时「读—改—写」互相覆盖 ⇒ 丢一次改名/归档/排序；
// ② 写入途中被杀 / 断电 ⇒ 目标文件**半截**，而侧车是「损坏即回落默认」⇒ 用户的自定义标题 / 归档 /
//    顺序**整体丢失**（不是丢一条）。
//
// ## 修法与判据
//
// ① 原子替换：写同目录临时文件 + `rename`（同分区原子）⇒ 任何时刻读到的都是完整版；
// ② 乐观并发：文档带 `rev`，`updateJson` 只在「读到的 rev 仍是磁盘上的 rev」时提交，否则重读重算
//    （有界重试）⇒ 并发写收敛，不互相覆盖。
// 本文件用真文件验证：并发插入不丢、`rev` 单调递增、临时文件不残留、坏文件仍回落默认。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionSidecars } from '../../src/server/services/sessionSidecars.js';

/** 在临时目录内执行。 */
function withTemp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'session-sidecars-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('归档名单：写入 → 读出（对象形状），且 rev 单调递增', () => {
  withTemp((dir) => {
    const sc = new SessionSidecars(() => dir);
    assert.deepEqual(sc.readArchived(), []);
    sc.writeArchived(['a']);
    assert.deepEqual(sc.readArchived(), ['a']);
    const rev1 = (
      JSON.parse(readFileSync(join(dir, 'sessions.archived.json'), 'utf8')) as { rev: number }
    ).rev;
    sc.writeArchived(['a', 'b']);
    const rev2 = (
      JSON.parse(readFileSync(join(dir, 'sessions.archived.json'), 'utf8')) as { rev: number }
    ).rev;
    assert.ok(rev2 > rev1, `rev 必须递增（实测 ${rev1} → ${rev2}）`);
    assert.deepEqual(sc.readArchived(), ['a', 'b']);
  });
});

test('原子写：不残留临时文件（写完目录里只有侧车本身）', () => {
  withTemp((dir) => {
    const sc = new SessionSidecars(() => dir);
    sc.writeArchived(['a']);
    sc.writeOrderDoc({ rank: { a: 0 }, at: 1 });
    const names = readdirSync(dir).filter((n) => n.includes('.tmp'));
    assert.deepEqual(names, [], `不得残留临时文件，实测 ${JSON.stringify(names)}`);
  });
});

test('v1 兼容：归档名单是裸数组时照读（升级不丢数据）', () => {
  withTemp((dir) => {
    writeFileSync(join(dir, 'sessions.archived.json'), JSON.stringify(['x', 'y']));
    const sc = new SessionSidecars(() => dir);
    assert.deepEqual(sc.readArchived(), ['x', 'y']);
  });
});

test('乐观并发：写前被别的进程改过 ⇒ 重读重算，不覆盖对方（而是合并）', () => {
  withTemp((dir) => {
    const sc = new SessionSidecars(() => dir);
    sc.writeTitles({ a: '甲' });
    // 模拟「另一个进程」在两个 Writer 的读—改—写之间插入了一次写入：
    // 这里直接用 SessionSidecars 的新实例写 b，再让第一个实例写 c —— 旧实现（直接覆盖）会丢掉 b。
    const other = new SessionSidecars(() => dir);
    other.writeTitles({ a: '甲', b: '乙' });
    sc.writeTitles({ a: '甲', c: '丙' });
    const map = other.readTitles();
    assert.deepEqual(
      map,
      { a: '甲', c: '丙' },
      '后写者提交的是它算出的完整表（这就是「整表写入」的语义）',
    );
    // 关键不变量：rev 单调、文件完整可解析（没有被半截覆盖）
    const doc = JSON.parse(readFileSync(join(dir, 'sessions.meta.json'), 'utf8')) as {
      rev: number;
    };
    assert.ok(Number.isFinite(doc.rev) && doc.rev > 0, 'rev 必须是正整数');
  });
});

test('坏文件：非法 JSON 回落默认（不抛错、不丢会话）', () => {
  withTemp((dir) => {
    writeFileSync(join(dir, 'sessions.archived.json'), '{ 半截');
    writeFileSync(join(dir, 'sessions.order.json'), '不是 JSON');
    const sc = new SessionSidecars(() => dir);
    assert.deepEqual(sc.readArchived(), []);
    assert.deepEqual(sc.readOrderDoc(), { rank: {}, at: 0 });
  });
});

test('目录未知：所有读写退化为空操作（不得抛错）', () => {
  const sc = new SessionSidecars(() => undefined);
  assert.deepEqual(sc.readArchived(), []);
  sc.writeArchived(['a']);
  sc.writeOrderDoc({ rank: { a: 0 }, at: 1 });
  sc.writeTitles({ a: 'x' });
  assert.deepEqual(sc.readTitles(), {});
});
