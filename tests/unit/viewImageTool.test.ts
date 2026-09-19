/**
 * view_image 单测（P2-⑬）：图片本体走 ToolResult.files 附件通道。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ViewImageTool } from '../../src/adapters/tool/media/viewImageTool.js';
import type { ToolContext } from '../../src/ports/tool/tool.js';

/**
 * 构造最小 PNG 字节（魔数 + IHDR 尺寸），用于离线测试。
 *
 * @param width 宽度（像素）。
 * @param height 高度（像素）。
 * @param padTo 补齐到的总字节数（默认不补齐）。
 * @returns PNG 字节。
 */
const pngBytes = (width: number, height: number, padTo = 24): Buffer => {
  const buffer = Buffer.alloc(Math.max(24, padTo));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
};

/** 工具上下文（workspaceRoot 由用例注入）。 */
const ctxOf = (root: string): ToolContext => ({ sessionId: 's1', workspaceRoot: root });

test('读取 PNG：返回元数据并把图片作为附件送出', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'viewimg-'));
  try {
    await writeFile(join(dir, 'shot.png'), pngBytes(640, 480));
    const tool = new ViewImageTool(dir);
    const result = await tool.handle(
      { id: 'c1', name: 'view_image', arguments: { path: 'shot.png' } },
      ctxOf(dir),
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.output?.includes('640×480'));
    const files = result.files;
    assert.strictEqual(files?.length, 1);
    assert.strictEqual(files?.[0]?.mediaType, 'image/png');
    assert.strictEqual(files?.[0]?.name, 'shot.png');
    assert.ok((files?.[0]?.data ?? '').length > 0, 'base64 内容不得为空');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('非图片文件被拒绝（不把二进制塞给模型）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'viewimg-'));
  try {
    await writeFile(join(dir, 'a.txt'), 'just text', 'utf8');
    const tool = new ViewImageTool(dir);
    const result = await tool.handle(
      { id: 'c1', name: 'view_image', arguments: { path: 'a.txt' } },
      ctxOf(dir),
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.files, undefined);
    assert.ok(result.error?.includes('不是可识别的图片'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('超过单张上限的图片被拒绝并给出可行动建议', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'viewimg-'));
  try {
    await writeFile(join(dir, 'huge.png'), pngBytes(10, 10, 5 * 1024 * 1024 + 1));
    const tool = new ViewImageTool(dir);
    const result = await tool.handle(
      { id: 'c1', name: 'view_image', arguments: { path: 'huge.png' } },
      ctxOf(dir),
    );
    assert.strictEqual(result.ok, false);
    assert.ok(result.error?.includes('超过单张上限'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('路径越界与文件不存在分别给出明确失败', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'viewimg-'));
  try {
    const tool = new ViewImageTool(dir);
    const escaped = await tool.handle(
      { id: 'c1', name: 'view_image', arguments: { path: '../secret.png' } },
      ctxOf(dir),
    );
    assert.strictEqual(escaped.ok, false);
    assert.ok(escaped.error?.includes('路径越界'));

    const missing = await tool.handle(
      { id: 'c2', name: 'view_image', arguments: { path: 'nope.png' } },
      ctxOf(dir),
    );
    assert.strictEqual(missing.ok, false);
    assert.ok(missing.error?.includes('不存在'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
