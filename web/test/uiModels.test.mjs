// 领域模型单测（第二组）：验证批次 2–4 抽取出的零 React 业务类。
// 全部为纯逻辑，node 直跑 web/dist 编译产物。

import assert from 'node:assert/strict';
import test from 'node:test';
import { FileKindClassifier } from '../dist/ui/models/FileKindClassifier.js';
import { NumberFormatter } from '../dist/ui/models/NumberFormatter.js';
import { ImportanceStars } from '../dist/ui/models/ImportanceStars.js';
import { PathJoiner } from '../dist/ui/models/PathJoiner.js';
import { FileIconResolver } from '../dist/ui/models/FileIconResolver.js';
import { FileSizeFormatter } from '../dist/ui/models/FileSizeFormatter.js';
import { ProviderStatusResolver } from '../dist/ui/models/ProviderStatus.js';
import { GraphDefBuilder } from '../dist/ui/models/GraphDefBuilder.js';

test('FileKindClassifier 分类代码 / markdown / 纯文本', () => {
  assert.equal(FileKindClassifier.classify('ts'), 'code');
  assert.equal(FileKindClassifier.classify('TS'), 'code', '大小写无关');
  assert.equal(FileKindClassifier.classify('json'), 'code');
  assert.equal(FileKindClassifier.classify('md'), 'markdown');
  assert.equal(FileKindClassifier.classify('markdown'), 'markdown');
  assert.equal(FileKindClassifier.classify('txt'), 'plain');
  assert.equal(FileKindClassifier.classify(undefined), 'plain', '未知语言 fail-closed 到纯文本');
});

test('NumberFormatter 千分位缩写', () => {
  assert.equal(NumberFormatter.abbrev(999), '999');
  assert.equal(NumberFormatter.abbrev(1234), '1.2k');
  assert.equal(NumberFormatter.abbrev(1234567), '1.23M');
  assert.equal(NumberFormatter.abbrev(NaN), '—', '非有限数 fail-closed');
});

test('ImportanceStars 星级夹紧到 0–5', () => {
  assert.equal(ImportanceStars.render(3), '★★★☆☆');
  assert.equal(ImportanceStars.render(0), '☆☆☆☆☆');
  assert.equal(ImportanceStars.render(9), '★★★★★', '超上限夹紧');
  assert.equal(ImportanceStars.render(-2), '☆☆☆☆☆', '负数夹紧');
});

test('PathJoiner 兼容 Windows 与 POSIX 且不产生双分隔符', () => {
  assert.equal(PathJoiner.join('C:\\src', 'app.ts'), 'C:\\src\\app.ts');
  assert.equal(PathJoiner.join('C:\\src\\', 'app.ts'), 'C:\\src\\app.ts', '尾部已有分隔符不重复');
  assert.equal(PathJoiner.join('/home/u', 'a.ts'), '/home/u/a.ts');
  assert.equal(PathJoiner.join('', 'a.ts'), 'a.ts');
});

test('FileIconResolver 按媒体类型给图标，未知回落', () => {
  assert.equal(FileIconResolver.emoji('image/png'), '🖼');
  assert.equal(FileIconResolver.emoji('video/mp4'), '🎬');
  assert.equal(FileIconResolver.emoji('application/pdf'), '📕');
  assert.equal(FileIconResolver.emoji('application/x-未知'), '📎');
});

test('FileSizeFormatter 体积格式化', () => {
  assert.equal(FileSizeFormatter.human(512), '512 B');
  assert.equal(FileSizeFormatter.human(2048), '2.0 KB');
  assert.equal(FileSizeFormatter.human(5 * 1024 * 1024), '5.0 MB');
  assert.equal(FileSizeFormatter.human(-1), '—', '负数 fail-closed');
});

test('ProviderStatusResolver 优先级：探测结果 > 已保存 Key > 默认', () => {
  const p = { id: 'x', label: 'X', adapter: 'openai', baseUrl: 'https://x', needsKey: true };
  const ok = ProviderStatusResolver.resolve(p, 'sk-***', { ok: true, models: ['a', 'b'], configured: true, source: 'live' });
  assert.equal(ok.ok, true);
  assert.match(ok.text, /可用 · 2 个模型/);
  const bad = ProviderStatusResolver.resolve(p, 'sk-***', { ok: false, models: [], configured: true, error: '401', source: 'live' });
  assert.equal(bad.ok, false);
  assert.match(bad.text, /不可用/);
  const saved = ProviderStatusResolver.resolve(p, 'sk-***', undefined);
  assert.match(saved.text, /未实测/);
  const none = ProviderStatusResolver.resolve(p, undefined, undefined);
  assert.equal(none.text, '未配置 Key');
  const free = ProviderStatusResolver.resolve({ ...p, needsKey: false }, undefined, undefined);
  assert.equal(free.text, '免 Key');
});

test('GraphDefBuilder 丢弃空行、切分依赖', () => {
  const def = GraphDefBuilder.build(' my-graph ', [
    { id: 'plan', dep: '', prompt: '列问题' },
    { id: '  ', dep: '', prompt: 'x' },
    { id: 'a', dep: 'plan, b ', prompt: '调研' },
    { id: 'b', dep: '', prompt: '' },
  ]);
  assert.equal(def.name, 'my-graph');
  assert.equal(def.steps.length, 2, 'id 或 prompt 为空的行被丢弃');
  assert.deepEqual(def.steps[1].dependsOn, ['plan', 'b']);
  assert.equal(def.maxConcurrency, 4);
});

test('GraphDefBuilder 状态类名映射与未知回落', () => {
  assert.equal(GraphDefBuilder.statusClass('running'), 'running');
  assert.equal(GraphDefBuilder.statusClass('done'), 'done');
  assert.equal(GraphDefBuilder.statusClass('failed'), 'failed');
  assert.equal(GraphDefBuilder.statusClass('skipped'), 'skipped');
  assert.equal(GraphDefBuilder.statusClass('weird'), 'pending', '未知状态 fail-closed');
});

test('GraphDefBuilder depText 还原依赖串', () => {
  assert.equal(GraphDefBuilder.depText(['a', 'b']), 'a,b');
  assert.equal(GraphDefBuilder.depText(undefined), '');
});
