/**
 * view_image 缩放端口单测（2026-10-02 第三方融合：sharp 接入）。
 *
 * 两组用例：
 *  1. 端口语义（无需 sharp）：假实现注入，验证「交付收敛结果 / undefined 走历史行为」两条路；
 *  2. sharp 真实实现（sharp 未安装时整组 skip，跳过原因可见）：验证大图真的被收敛进预算。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomFillSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ViewImageTool } from '../../src/adapters/tool/media/viewImageTool.js';
import { SharpImageResizer } from '../../src/adapters/media/sharpImageResizer.js';
import type {
  ImageResizeOutcome,
  ImageResizeRequest,
  ImageResizerPort,
} from '../../src/ports/media/imageResizer.js';
import { RequireEnv } from '../helpers/requireEnv.js';
import type { ToolContext } from '../../src/ports/tool/tool.js';

/** sharp 是否可用（决定第二组用例是否 skip；import 失败即视为不可用）。 */
const hasSharp: boolean = await import('sharp').then(
  () => true,
  () => false,
);

/**
 * sharp 组用例的 skip 选项。
 *
 * 2026-10-11：接 `OMNI_REQUIRE_SHARP` 开关——`sharp` 是 optionalDependency，省略安装时
 * "真实实现路径"整组静默跳过（本仓当年就因此让缩放能力长期没有实证）。声明必须在场时改为失败。
 */
const sharpSkip = RequireEnv.skipUnless(
  'OMNI_REQUIRE_SHARP',
  hasSharp,
  'sharp 未安装（optionalDependencies 被省略）',
);

/** 工具上下文（workspaceRoot 由用例注入）。 */
const ctxOf = (root: string): ToolContext => ({ sessionId: 's1', workspaceRoot: root });

/** 最小合法 PNG 头（魔数 + IHDR 尺寸），ImageProbe 据此识别。 */
const pngBytes = (width: number, height: number, padTo = 24): Buffer => {
  const buffer = Buffer.alloc(Math.max(24, padTo));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
};

/** 固定的缩放结果（假实现返回值）。 */
const fakeOutcome = (bytes: Buffer): ImageResizeOutcome => ({
  bytes,
  mediaType: 'image/png',
  width: 800,
  height: 600,
  resized: true,
});

/** 按给定脚本回答的假缩放端口（记录收到的请求供断言）。 */
class ScriptedImageResizer implements ImageResizerPort {
  /** 实现名。 */
  public readonly name = 'scripted';
  /** 收到的请求（按调用顺序）。 */
  public readonly seen: ImageResizeRequest[] = [];

  /**
   * @param script 每次调用依次返回的结果；耗尽后恒为 undefined。
   */
  public constructor(private readonly script: (ImageResizeOutcome | undefined)[]) {}

  /**
   * 弹出脚本下一项。
   *
   * @param request 缩放请求。
   * @returns 脚本结果。
   */
  public async resize(request: ImageResizeRequest): Promise<ImageResizeOutcome | undefined> {
    this.seen.push(request);
    return this.script.shift();
  }
}

test('缩放端口交付收敛结果：附件为缩放产物且如实说明', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imgresize-'));
  try {
    await writeFile(join(dir, 'photo.png'), pngBytes(4000, 3000));
    const small = Buffer.from('fake-small-bytes');
    const resizer = new ScriptedImageResizer([fakeOutcome(small)]);
    const tool = new ViewImageTool(dir, resizer);
    const result = await tool.handle(
      { id: 'c1', name: 'view_image', arguments: { path: 'photo.png' } },
      ctxOf(dir),
    );
    assert.strictEqual(result.ok, true);
    // 预算参数必须由工具下发（长边 1568 / 5MiB，与工具常量同源）。
    assert.strictEqual(resizer.seen[0]?.maxDimension, 1568);
    assert.strictEqual(resizer.seen[0]?.maxBytes, 5 * 1024 * 1024);
    assert.strictEqual(result.files?.[0]?.mediaType, 'image/png');
    assert.strictEqual(result.files?.[0]?.data, small.toString('base64'));
    assert.ok(result.output?.includes('已收敛'), '必须如实告知缩过');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('缩放端口返回 undefined：退化为历史行为（超限拒绝 / 达标原样交付）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imgresize-'));
  try {
    // 超限 + undefined ⇒ 拒绝（历史行为）。
    await writeFile(join(dir, 'huge.png'), pngBytes(10, 10, 5 * 1024 * 1024 + 1));
    const tool = new ViewImageTool(dir, new ScriptedImageResizer([undefined]));
    const rejected = await tool.handle(
      { id: 'c1', name: 'view_image', arguments: { path: 'huge.png' } },
      ctxOf(dir),
    );
    assert.strictEqual(rejected.ok, false);
    assert.ok(rejected.error?.includes('超过单张上限'));

    // 达标 + undefined ⇒ 原样交付。
    await writeFile(join(dir, 'ok.png'), pngBytes(320, 240));
    const tool2 = new ViewImageTool(dir, new ScriptedImageResizer([undefined]));
    const delivered = await tool2.handle(
      { id: 'c2', name: 'view_image', arguments: { path: 'ok.png' } },
      ctxOf(dir),
    );
    assert.strictEqual(delivered.ok, true);
    assert.ok(delivered.output?.includes('320×240'));
    assert.ok((delivered.files?.[0]?.data ?? '').length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('未装配缩放端口：行为与历史一致', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imgresize-'));
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

test('sharp 真实实现：大 PNG 被收敛进长边与字节双预算', { skip: sharpSkip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imgresize-sharp-'));
  try {
    // 真随机噪声 PNG：不可压缩，2400×1600 的 RGBA 编码后必然超过 5MiB，
    // 能同时触发「长边超限」与「单帧字节超限 → 逐步再缩」两条路径。
    // （测试只依赖「超预算」这一事实，不依赖具体字节；前置断言兜底。）
    const width = 2400;
    const height = 1600;
    const noise = randomFillSync(Buffer.alloc(width * height * 4));
    const sharp = await import('sharp');
    const factory = sharp.default ?? (sharp as unknown as typeof sharp.default);
    const bigPng = await factory(noise, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();
    assert.ok(bigPng.byteLength > 5 * 1024 * 1024, '测试前置：源图必须真超预算');
    await writeFile(join(dir, 'noise.png'), bigPng);

    const tool = new ViewImageTool(dir, new SharpImageResizer());
    const result = await tool.handle(
      { id: 'c1', name: 'view_image', arguments: { path: 'noise.png' } },
      ctxOf(dir),
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.output?.includes('已收敛'), '必须如实告知缩过');
    const attachment = result.files?.[0];
    assert.strictEqual(attachment?.mediaType, 'image/png');
    const bytes = Buffer.from(attachment?.data ?? '', 'base64');
    assert.ok(bytes.byteLength <= 5 * 1024 * 1024, '交付字节必须 ≤ 单图上限');
    assert.ok(bytes.byteLength < bigPng.byteLength, '交付字节必须小于原图');
    // base64 头两个字节即 PNG 魔数，交叉验证交付的是合法 PNG。
    assert.strictEqual(attachment?.data?.slice(0, 8), 'iVBORw0K');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  'sharp 真实实现：达标小图原样透传（resized:false 不触碰字节）',
  { skip: sharpSkip },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imgresize-sharp-'));
    try {
      const sharp = await import('sharp');
      const factory = sharp.default ?? (sharp as unknown as typeof sharp.default);
      const tiny = await factory({
        create: {
          width: 100,
          height: 80,
          channels: 4,
          background: { r: 255, g: 0, b: 0, alpha: 1 },
        },
      })
        .png()
        .toBuffer();
      await writeFile(join(dir, 'tiny.png'), tiny);

      const tool = new ViewImageTool(dir, new SharpImageResizer());
      const result = await tool.handle(
        { id: 'c1', name: 'view_image', arguments: { path: 'tiny.png' } },
        ctxOf(dir),
      );
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.files?.[0]?.data, tiny.toString('base64'), '字节必须原样透传');
      assert.ok(!result.output?.includes('已收敛'), '未缩放不得谎报');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
