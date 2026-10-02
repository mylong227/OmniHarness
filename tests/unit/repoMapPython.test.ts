/**
 * repoMap Python 抽取单测（能力审计 C6 修复，2026-10-02）。
 *
 * 此前缺口：`async def` 完全抽不到（现代 Python 协程主力形态）、import/from-import
 * 不进符号索引（查询提到模块名时文件无法入候选池）。本文件锁定修复后的契约。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RepoMap, type SymbolNode } from '../../src/context/repoMap/repoMap.js';

/** 按种类过滤符号。 */
const ofKind = (nodes: readonly SymbolNode[], kind: string): SymbolNode[] =>
  nodes.filter((n) => n.kind === kind);

const PY_SAMPLE = [
  'import os',
  'import models.user as mu',
  'from models.user import User',
  'from . import helpers',
  '',
  'class UserRepository(BaseRepo):',
  '    def load(self, uid):',
  '        return mu.find(uid)',
  '',
  '    async def load_many(self, uids):',
  '        return [self.load(u) for u in uids]',
  '',
  'async def fetch_user(client, uid):',
  '    return await client.get(uid)',
].join('\n');

test('async def 与同步 def 都被抽取（此前 async def 完全丢失）', () => {
  const nodes = RepoMap.extractSymbols('a/service.py', PY_SAMPLE);
  const fns = ofKind(nodes, 'function').map((n) => n.name);
  assert.ok(fns.includes('load'), '类方法 def 必须抽出（缩进允许）');
  assert.ok(fns.includes('load_many'), 'async def 方法必须抽出');
  assert.ok(fns.includes('fetch_user'), '顶层 async def 必须抽出');
});

test('import / from-import 进符号索引（拓宽 Python 仓候选池）', () => {
  const nodes = RepoMap.extractSymbols('a/service.py', PY_SAMPLE);
  const imports = ofKind(nodes, 'import').map((n) => n.name);
  assert.ok(imports.includes('os'));
  assert.ok(imports.includes('models.user'), '带点模块名完整保留');
  assert.ok(imports.includes('models.user'), 'from-import 捕获源模块');
  assert.ok(imports.includes('helpers'), '相对导入 from . import 捕获目标名');
});

test('类与行号保持既有契约', () => {
  const nodes = RepoMap.extractSymbols('a/service.py', PY_SAMPLE);
  const cls = ofKind(nodes, 'class');
  assert.strictEqual(cls.length, 1);
  assert.strictEqual(cls[0]?.name, 'UserRepository');
  assert.strictEqual(cls[0]?.line, 6);
});

test('TS 文件不受 Python 规则影响（无 import 符号，冻结口径不变）', () => {
  const nodes = RepoMap.extractSymbols(
    'a/x.ts',
    'import { foo } from "./foo.js";\nexport class A {}\n',
  );
  assert.strictEqual(
    ofKind(nodes, 'import').length,
    0,
    'TS 通道不引入 import 符号（评测口径冻结）',
  );
  assert.ok(ofKind(nodes, 'class').length === 1);
});
