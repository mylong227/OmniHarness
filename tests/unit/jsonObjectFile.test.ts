import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'vitest';
import { JsonObjectFile } from '../../src/util/jsonObjectFile.ts';

const dirs: string[] = [];

/** 建一个临时目录（用例后统一清理）。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'json-object-file-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('缺失文件 / 非法 JSON / 数组 / null ⇒ 空对象（读路径 fail-soft）', () => {
  const dir = tempDir();
  const missing = join(dir, 'missing.json');
  assert.deepEqual(JsonObjectFile.readRecord(missing), {});

  const invalid = join(dir, 'invalid.json');
  writeFileSync(invalid, '{not json');
  assert.deepEqual(JsonObjectFile.readRecord(invalid), {});

  const array = join(dir, 'array.json');
  writeFileSync(array, '[1,2]');
  assert.deepEqual(JsonObjectFile.readRecord(array), {});

  const nul = join(dir, 'null.json');
  writeFileSync(nul, 'null');
  assert.deepEqual(JsonObjectFile.readRecord(nul), {});
});

test('合法对象原样返回（含嵌套值）', () => {
  const dir = tempDir();
  const file = join(dir, 'ok.json');
  writeFileSync(file, JSON.stringify({ a: 1, nested: { b: true } }));
  assert.deepEqual(JsonObjectFile.readRecord(file), { a: 1, nested: { b: true } });
});
