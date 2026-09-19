/**
 * HTML → 文本单测（web_fetch 的正文提取，零依赖）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HtmlToText } from '../../src/util/htmlToText.js';

test('整块丢弃 script/style 的内容', () => {
  const html = '<p>正文</p><script>var a=1;function b(){}</script><style>.x{color:red}</style>';
  const text = HtmlToText.convert(html);
  assert.ok(text.includes('正文'));
  assert.strictEqual(text.includes('var a=1'), false, 'script 内容不得残留');
  assert.strictEqual(text.includes('color:red'), false, 'style 内容不得残留');
});

test('块级标签换行、列表项加前缀、表格单元格分隔', () => {
  const html =
    '<div>第一段</div><div>第二段</div><ul><li>甲</li><li>乙</li></ul><table><tr><td>A</td><td>B</td></tr></table>';
  const text = HtmlToText.convert(html);
  assert.ok(text.includes('第一段\n第二段'), `实际: ${text}`);
  assert.ok(text.includes('- 甲'));
  assert.ok(text.includes('A | B'));
});

test('命名实体与数字实体解码', () => {
  const text = HtmlToText.convert('<p>a &amp; b &lt;c&gt; &nbsp;d &#65;&#x42;</p>');
  assert.ok(text.includes('a & b <c>'));
  assert.ok(text.includes('d AB'), `实际: ${text}`);
});

test('HTML 注释被移除；连续空行收敛为至多一个', () => {
  const text = HtmlToText.convert('<p>x</p><!-- 注释 --><div></div><div></div><p>y</p>');
  assert.strictEqual(text.includes('注释'), false);
  assert.ok(text.startsWith('x\n\ny'), `实际: ${JSON.stringify(text)}`);
  assert.strictEqual(text.includes('\n\n\n'), false, '不得出现连续三个换行');
});

test('空输入返回空串；非法实体码点不抛错', () => {
  assert.strictEqual(HtmlToText.convert(''), '');
  assert.doesNotThrow(() => HtmlToText.convert('&#99999999;ok'));
});

test('标题保留层级信号（h1→#，h3→###）', () => {
  const text = HtmlToText.convert('<h1>首页</h1><p>正文</p><h3>子节</h3>');
  assert.ok(text.includes('# 首页'), `实际: ${text}`);
  assert.ok(text.includes('### 子节'), `实际: ${text}`);
});

test('链接保留可见文本与绝对 href（过滤锚点/伪协议）', () => {
  const text = HtmlToText.convert(
    '<p><a href="https://example.com/doc">文档</a> 与 ' +
      '<a href="#top">回到顶部</a> 与 ' +
      '<a href="javascript:void(0)">点我</a></p>',
  );
  assert.ok(text.includes('文档 (https://example.com/doc)'), `实际: ${text}`);
  assert.ok(text.includes('回到顶部'), '锚点链接保留文本');
  assert.strictEqual(text.includes('javascript:'), false, '伪协议链接不得泄露 href');
});
