// 产物解析器单测（D5）：覆盖「产物画廊 ≥5 工具」的解析规则 + fail-closed 安全边界。
// 零 React 依赖，直跑 web/dist。
import assert from 'node:assert/strict';
import test from 'node:test';
import { ArtifactResolver } from '../dist/ui/models/ArtifactResolver.js';

test('write_file：取 path 字段，kind=file，name 为末段', () => {
  const info = ArtifactResolver.fromTool('write_file', { path: 'src/demo.ts', content: 'x' });
  assert.deepEqual(info, { name: 'demo.ts', relPath: 'src/demo.ts', kind: 'file' });
});

test('apply_patch：kind=patch', () => {
  const info = ArtifactResolver.fromTool('apply_patch', { path: 'src/a.ts', patch: '@@' });
  assert.deepEqual(info, { name: 'a.ts', relPath: 'src/a.ts', kind: 'patch' });
});

test('read_file：按文件引用展示，kind=file', () => {
  const info = ArtifactResolver.fromTool('read_file', { path: 'docs/spec.md' });
  assert.deepEqual(info, { name: 'spec.md', relPath: 'docs/spec.md', kind: 'file' });
});

test('LSP 三工具：入参用 file 字段，同样产出文件引用卡片', () => {
  for (const name of ['lsp_hover', 'lsp_go_to_definition', 'lsp_find_references']) {
    const info = ArtifactResolver.fromTool(name, { file: 'src/core/loop.ts', line: 3, character: 1 });
    assert.deepEqual(info, { name: 'loop.ts', relPath: 'src/core/loop.ts', kind: 'file' }, name);
  }
});

test('sketch_write：路径由结果回执回读，kind=sketch', () => {
  const info = ArtifactResolver.fromTool(
    'sketch_write',
    { name: '流程草图', content: 'graph TD' },
    '草图已保存: .omniharness/sketches/20260914-1030-flow.mmd（42 字符，格式 mermaid）',
  );
  assert.deepEqual(info, {
    name: '20260914-1030-flow.mmd',
    relPath: '.omniharness/sketches/20260914-1030-flow.mmd',
    kind: 'sketch',
  });
});

test('sketch_write：无结果回执时 fail-closed（不猜路径）', () => {
  assert.strictEqual(ArtifactResolver.fromTool('sketch_write', { name: 'x', content: 'y' }), null);
  assert.strictEqual(ArtifactResolver.fromTool('sketch_write', { name: 'x', content: 'y' }, '已写入'), null);
});

test('覆盖广度：产物解析器至少覆盖 5 个工具', () => {
  const covered = [
    'write_file',
    'apply_patch',
    'read_file',
    'lsp_hover',
    'lsp_go_to_definition',
    'lsp_find_references',
    'sketch_write',
  ].filter((n) => ArtifactResolver.fromTool(n, { path: 'a.ts', file: 'a.ts' }, '草图已保存: a.mmd') !== null);
  assert.ok(covered.length >= 5, `覆盖工具数应 ≥5，实际 ${covered.length}`);
});

test('未登记工具一律不产卡片（fail-closed）', () => {
  assert.strictEqual(ArtifactResolver.fromTool('shell', { command: 'ls' }), null);
  assert.strictEqual(ArtifactResolver.fromTool('web_search', { query: 'x' }), null);
  assert.strictEqual(ArtifactResolver.fromTool('list_dir', { path: 'src' }), null);
});

test('路径归一：反斜杠与 ./ 前缀被规整，展示名取末段', () => {
  const info = ArtifactResolver.fromTool('write_file', { path: '.\\src\\ui\\App.tsx' });
  assert.deepEqual(info, { name: 'App.tsx', relPath: 'src/ui/App.tsx', kind: 'file' });
});

test('fail-closed：绝对路径 / 家目录 / 越界 .. / 空串 一律 null', () => {
  for (const bad of ['/etc/passwd', 'C:\\Windows\\x.txt', '\\\\srv\\share\\a', '~/secrets', '../../etc/x', '..', '', '   ']) {
    assert.strictEqual(ArtifactResolver.fromTool('write_file', { path: bad }), null, `应拒绝: ${JSON.stringify(bad)}`);
  }
});

test('fail-closed：非对象入参不抛异常且返回 null', () => {
  for (const bad of [null, undefined, 42, 'src/a.ts', true]) {
    assert.strictEqual(ArtifactResolver.fromTool('write_file', bad), null);
  }
});
