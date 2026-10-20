import { test } from 'vitest';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { PdfTextExtractor } from '../../src/util/pdfTextExtractor.ts';

/**
 * 造一个最小合法 PDF；内容流用十六进制字符串（自研正则不认 `<...> Tj`，PDF.js 认）。
 * @returns PDF 字节。
 */
function hexTextPdf(): Buffer {
  const content = 'BT /F1 18 Tf 72 720 Td <48656C6C6F20504446> Tj ET';
  const compressed = deflateSync(Buffer.from(content));
  const objs = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>endobj',
    Buffer.concat([
      Buffer.from(`4 0 obj<</Length ${compressed.length}/Filter/FlateDecode>>stream\n`),
      compressed,
      Buffer.from('\nendstream endobj'),
    ]).toString('latin1'),
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const obj of objs) {
    offsets.push(body.length);
    body += `${obj}\n`;
  }
  const xref = body.length;
  body +=
    `xref\n0 ${String(objs.length + 1)}\n0000000000 65535 f \n` +
    offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer<</Size ${String(objs.length + 1)}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body, 'latin1');
}

test('ACT-03：从简单 PDF 内容流提取 Tj/TJ 文本', () => {
  const pdf = Buffer.from(
    '%PDF-1.4\n1 0 obj << /Length 44 >>\nstream\nBT /F1 12 Tf (Hello World) Tj ET\nendstream\nendobj\n',
    'latin1',
  );
  assert.strictEqual(PdfTextExtractor.extract(pdf), 'Hello World');
});

test('ACT-03：unpdf 可选增强能读十六进制字符串（正则 fallback 读不到）', async () => {
  const pdf = hexTextPdf();
  assert.strictEqual(PdfTextExtractor.extract(pdf), '', '自研正则不应识别 <...> Tj');
  assert.strictEqual(await PdfTextExtractor.extractAsync(pdf), 'Hello PDF');
});

test('ACT-03：图片型/无文本 PDF 返回空串（调用方必须如实说明）', () => {
  const pdf = Buffer.from(
    '%PDF-1.4\n1 0 obj << /Length 0 >>\nstream\n\nendstream\nendobj\n',
    'latin1',
  );
  assert.strictEqual(PdfTextExtractor.extract(pdf), '');
});
