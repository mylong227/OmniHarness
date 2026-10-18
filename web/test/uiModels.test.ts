// 领域模型单测（第二组）：验证批次 2–4 抽取出的零 React 业务类。
// 全部为纯逻辑，node 直跑 web/dist 编译产物。

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { FileKindClassifier } from '../src/ui/models/FileKindClassifier.ts';
import { NumberFormatter } from '../src/ui/models/NumberFormatter.ts';
import { ImportanceStars } from '../src/ui/models/ImportanceStars.ts';
import { PathJoiner } from '../src/ui/models/PathJoiner.ts';
import { FileIconResolver } from '../src/ui/models/FileIconResolver.ts';
import { FileSizeFormatter } from '../src/ui/models/FileSizeFormatter.ts';
import { ProviderStatusResolver } from '../src/ui/models/ProviderStatus.ts';
import { GraphDefBuilder } from '../src/ui/models/GraphDefBuilder.ts';
import { ComposerDraft } from '../src/ui/models/ComposerDraft.ts';
import type { ProviderPreset } from '../src/types/models.ts';

test('FileKindClassifier 分类代码 / markdown / 纯文本', () => {
  assert.strictEqual(FileKindClassifier.classify('ts'), 'code');
  assert.strictEqual(FileKindClassifier.classify('TS'), 'code', '大小写无关');
  assert.strictEqual(FileKindClassifier.classify('json'), 'code');
  assert.strictEqual(FileKindClassifier.classify('md'), 'markdown');
  assert.strictEqual(FileKindClassifier.classify('markdown'), 'markdown');
  assert.strictEqual(FileKindClassifier.classify('txt'), 'plain');
  assert.strictEqual(FileKindClassifier.classify(undefined), 'plain', '未知语言 fail-closed 到纯文本');
});

test('NumberFormatter 千分位缩写', () => {
  assert.strictEqual(NumberFormatter.abbrev(999), '999');
  assert.strictEqual(NumberFormatter.abbrev(1234), '1.2k');
  assert.strictEqual(NumberFormatter.abbrev(1234567), '1.23M');
  assert.strictEqual(NumberFormatter.abbrev(NaN), '—', '非有限数 fail-closed');
});

test('ImportanceStars 星级夹紧到 0–5', () => {
  assert.strictEqual(ImportanceStars.render(3), '★★★☆☆');
  assert.strictEqual(ImportanceStars.render(0), '☆☆☆☆☆');
  assert.strictEqual(ImportanceStars.render(9), '★★★★★', '超上限夹紧');
  assert.strictEqual(ImportanceStars.render(-2), '☆☆☆☆☆', '负数夹紧');
});

test('PathJoiner 兼容 Windows 与 POSIX 且不产生双分隔符', () => {
  assert.strictEqual(PathJoiner.join('C:\\src', 'app.ts'), 'C:\\src\\app.ts');
  assert.strictEqual(PathJoiner.join('C:\\src\\', 'app.ts'), 'C:\\src\\app.ts', '尾部已有分隔符不重复');
  assert.strictEqual(PathJoiner.join('/home/u', 'a.ts'), '/home/u/a.ts');
  assert.strictEqual(PathJoiner.join('', 'a.ts'), 'a.ts');
});

test('FileIconResolver 按媒体类型给图标名（线性图标集），未知回落', () => {
  // 断言的是**图标名**而不是 emoji：emoji 形态已于 2026-10-07 删除（口径见 web/test/iconPolicy.test.mjs）。
  assert.strictEqual(FileIconResolver.iconName('image/png'), 'image');
  assert.strictEqual(FileIconResolver.iconName('video/mp4'), 'video');
  assert.strictEqual(FileIconResolver.iconName('application/pdf'), 'book');
  assert.strictEqual(FileIconResolver.iconName('application/x-未知'), 'paperclip');
  assert.strictEqual(FileIconResolver.iconName(''), 'paperclip', '空 MIME 也必须 fail-closed 到中性图标');
});

test('FileSizeFormatter 体积格式化', () => {
  assert.strictEqual(FileSizeFormatter.human(512), '512 B');
  assert.strictEqual(FileSizeFormatter.human(2048), '2.0 KB');
  assert.strictEqual(FileSizeFormatter.human(5 * 1024 * 1024), '5.0 MB');
  assert.strictEqual(FileSizeFormatter.human(-1), '—', '负数 fail-closed');
});

test('ProviderStatusResolver 优先级：探测结果 > 已保存 Key > 默认', () => {
  // 按 ProviderPreset 真实形状补齐 defaultModel / models（不影响 resolve 逻辑）
  const p: ProviderPreset = {
    id: 'x',
    label: 'X',
    adapter: 'openai',
    baseUrl: 'https://x',
    defaultModel: '',
    needsKey: true,
    models: [],
  };
  // probe 按 ProviderProbeResult 真实形状补齐 id / label；source 是探测来源枚举（resolve 不读它），
  // 测试里的旧值 'live' 已不在枚举内，取最接近"实测"语义的 'models-endpoint'，不影响断言。
  const ok = ProviderStatusResolver.resolve(p, 'sk-***', {
    id: 'x',
    label: 'X',
    ok: true,
    models: ['a', 'b'],
    configured: true,
    source: 'models-endpoint',
  });
  assert.strictEqual(ok.ok, true);
  assert.match(ok.text, /可用 · 2 个模型/);
  const bad = ProviderStatusResolver.resolve(p, 'sk-***', {
    id: 'x',
    label: 'X',
    ok: false,
    models: [],
    configured: true,
    error: '401',
    source: 'models-endpoint',
  });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.text, /不可用/);
  const saved = ProviderStatusResolver.resolve(p, 'sk-***', undefined);
  assert.match(saved.text, /未实测/);
  const none = ProviderStatusResolver.resolve(p, undefined, undefined);
  assert.strictEqual(none.text, '未配置 Key');
  const free = ProviderStatusResolver.resolve({ ...p, needsKey: false }, undefined, undefined);
  assert.strictEqual(free.text, '免 Key');
});

test('GraphDefBuilder 丢弃空行、切分依赖', () => {
  const def = GraphDefBuilder.build(' my-graph ', [
    { id: 'plan', dep: '', prompt: '列问题' },
    { id: '  ', dep: '', prompt: 'x' },
    { id: 'a', dep: 'plan, b ', prompt: '调研' },
    { id: 'b', dep: '', prompt: '' },
  ]);
  assert.strictEqual(def.name, 'my-graph');
  assert.strictEqual(def.steps.length, 2, 'id 或 prompt 为空的行被丢弃');
  assert.deepEqual(def.steps[1].dependsOn, ['plan', 'b']);
  assert.strictEqual(def.maxConcurrency, 4);
});

test('GraphDefBuilder 状态类名映射与未知回落', () => {
  assert.strictEqual(GraphDefBuilder.statusClass('running'), 'running');
  assert.strictEqual(GraphDefBuilder.statusClass('done'), 'done');
  assert.strictEqual(GraphDefBuilder.statusClass('failed'), 'failed');
  assert.strictEqual(GraphDefBuilder.statusClass('skipped'), 'skipped');
  assert.strictEqual(GraphDefBuilder.statusClass('weird'), 'pending', '未知状态 fail-closed');
});

test('GraphDefBuilder depText 还原依赖串', () => {
  assert.strictEqual(GraphDefBuilder.depText(['a', 'b']), 'a,b');
  assert.strictEqual(GraphDefBuilder.depText(undefined), '');
});

test('ComposerDraft.fill 把文本写回输入框并聚焦、光标落到末尾（F4 编辑重发）', () => {
  /** 记录 fill 对输入框的副作用 */
  interface SeenFixture {
    focused: number;
    caret: [number, number] | null;
  }
  const seen: SeenFixture = { focused: 0, caret: null };
  const ta = {
    value: '旧草稿',
    focus() {
      seen.focused += 1;
    },
    setSelectionRange(start: number, end: number) {
      seen.caret = [start, end];
    },
  };
  ComposerDraft.fill(ta, '第二条消息');
  assert.strictEqual(ta.value, '第二条消息', '必须覆盖输入框原值');
  assert.strictEqual(seen.focused, 1, '必须聚焦，用户可直接续写');
  assert.deepEqual(seen.caret, [5, 5], '光标必须落到文本末尾');
});

test('ComposerDraft.fill 对缺失输入框 / 无 setSelectionRange 的桩 fail-safe', () => {
  assert.doesNotThrow(() => ComposerDraft.fill(null, 'x'), '输入框未挂载时不得抛错');
  const bare = { value: '', focus() {} };
  ComposerDraft.fill(bare, 'abc');
  assert.strictEqual(bare.value, 'abc', '无光标 API 的桩也要完成回填');
});
