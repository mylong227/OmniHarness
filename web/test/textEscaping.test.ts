// React 文本节点不得二次转义（2026-10-18 审查 R-02）。
//
// `format.esc()` 只用于 `dangerouslySetInnerHTML` / 拼接 HTML 字符串；把它当 JSX 子节点或
// 属性值会把 `"` 变成 `&quot;`、`&` 变成 `&amp;`，用户看到的是转义实体（工具输出是 JSON，
// 几乎每个值都带引号）。本判据用两个最典型的展示组件钉住“渲染层直接给原文”。

// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { renderFacade } from './rtlHarness.ts';
import { allText } from './domFacade.ts';

const { AttachmentChips } = await import('../src/ui/components/stream/AttachmentChips.tsx');
const { ExternalLinkCards } = await import('../src/ui/components/stream/ExternalLinkCards.tsx');

test('附件 chip：文件名中的引号/& 原样显示（不得出现 &quot; / &amp;）', () => {
  const name = 'a"b&c<d>.ts';
  const { node } = renderFacade(AttachmentChips, {
    props: { files: [{ name, mediaType: 'text/plain' }] },
  });
  assert.strictEqual(allText(node), name);
  assert.doesNotMatch(allText(node), /&quot;|&amp;|&lt;/u);
});

test('外链卡片：URL 与主机名原样显示（查询串里的 & 不得变成 &amp;）', () => {
  const url = 'https://example.com/a?x=1&y=2';
  const { node } = renderFacade(ExternalLinkCards, { props: { urls: [url] } });
  const text = allText(node);
  assert.match(text, /example\.com/u);
  assert.match(text, /x=1&y=2/u);
  assert.doesNotMatch(text, /&amp;/u);
});
