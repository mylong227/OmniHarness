// 拖拽附件通道决策（AttachmentDrop）判据：桌面桥有真实路径 ⇒ 走服务端；
// 浏览器/虚拟文件/部分失败 ⇒ 整批回落浏览器读（全有或全无）。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { pathsForDrop } from '../src/ui/models/AttachmentDrop.ts';

/** jsdom 的 File 构造（内容无所谓，只看身份）。 */
function file(name: string): File {
  return new File(['x'], name, { type: 'text/plain' });
}

test('pathsForDrop：浏览器（无 pathFor）⇒ null，回落浏览器读', () => {
  const files = [file('a.txt'), file('b.png')];
  assert.strictEqual(pathsForDrop(files, undefined), null);
});

test('pathsForDrop：空拖拽 ⇒ null（没有东西可决策）', () => {
  assert.strictEqual(pathsForDrop([], () => 'D:\\x'), null);
});

test('pathsForDrop：全部取到路径 ⇒ 原顺序返回路径列表', () => {
  const a = file('a.txt');
  const b = file('b.png');
  const out = pathsForDrop([a, b], (f) => `D:\\dl\\${f.name}`);
  assert.deepEqual(out, ['D:\\dl\\a.txt', 'D:\\dl\\b.png']);
});

test('pathsForDrop：单个文件取不到路径（空串）⇒ 整批 null（全有或全无）', () => {
  const files = [file('a.txt'), file('virtual://b')];
  const out = pathsForDrop(files, (f) => (f.name === 'a.txt' ? 'D:\\dl\\a.txt' : ''));
  assert.strictEqual(out, null, '一半路径一半内容会让同类附件有两种生命周期，整批回落');
});

test('pathsForDrop：pathFor 抛错 ⇒ 整批 null（降级不能让拖拽失败）', () => {
  const out = pathsForDrop([file('a.txt')], () => {
    throw new Error('bridge gone');
  });
  assert.strictEqual(out, null);
});
