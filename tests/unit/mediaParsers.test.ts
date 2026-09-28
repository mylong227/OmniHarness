/**
 * 元数据解析单测：ffprobe JSON 优先、ffmpeg stderr 兜底。
 *
 * 两条路的样本都取自**真实输出**（本机 ffmpeg 7.1 对 160x120 / 10fps / 3.0s 的
 * h264 mp4 跑 `-i` 的 stderr 原文），而不是凭印象手写的"差不多"格式——
 * 正则写错在假样本上照样通过，在真样本上才会露馅（本仓"探针自带被测逻辑副本"的教训）。
 *
 * 判据的核心是**不猜**：任一字段读不出就给 `undefined`，绝不拿默认值冒充。
 * 时长猜错会让整批帧的时间戳全错，比"未知"更糟。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { FfmpegStderrParser } from '../../src/media/ffmpegStderrParser.js';
import { FfprobeJsonParser } from '../../src/media/ffprobeJsonParser.js';

/** 真实 ffmpeg stderr（节选：输入摘要 + 视频流行；来自本机 ffmpeg 对 cuts.mp4 的 `-i`）。 */
const REAL_STDERR = `ffmpeg version 7.1-full_build Copyright (c) 2000-2024 the FFmpeg developers
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'cuts.mp4':
  Metadata:
    major_brand     : isom
    minor_version   : 512
    compatible_brands: isomiso2avc1mp41
    encoder         : Lavf61.7.100
  Duration: 00:00:03.00, start: 0.000000, bitrate: 23 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt470bg/unknown/unknown, progressive), 160x120 [SAR 1:1 DAR 4:3], 20 kb/s, 10 fps, 10 tbr, 10240 tbn (default)
      Metadata:
        handler_name    : VideoHandler
        vendor_id       : [0][0][0][0]
Stream mapping:
  Stream #0:0 -> #0:0 (h264 (native) -> mjpeg (native))
At least one output file must be specified
`;

test('ffmpeg stderr：从真实输出里取出容器 / 时长 / 编码 / 尺寸 / 帧率', () => {
  const facts = FfmpegStderrParser.parse(REAL_STDERR);
  assert.ok(facts !== undefined, '有输入行就必须解析成功');
  assert.strictEqual(facts.container, 'mov,mp4,m4a,3gp,3g2,mj2', '容器名本身含逗号，必须整段取到');
  assert.strictEqual(facts.durationMs, 3000);
  assert.strictEqual(facts.codec, 'h264');
  assert.strictEqual(facts.width, 160);
  assert.strictEqual(facts.height, 120);
  assert.strictEqual(facts.frameRate, 10);
  assert.strictEqual(facts.frameCount, undefined, 'stderr 不给帧数 ⇒ 如实为 undefined（不猜）');
});

test('ffmpeg stderr：十六进制串不得被误当成尺寸（`0x31637661`）', () => {
  const text = REAL_STDERR.replace('160x120', '64x48');
  const facts = FfmpegStderrParser.parse(text);
  assert.strictEqual(facts?.width, 64, '尺寸取的是真实的那一对，而非十六进制串里的数字');
  assert.strictEqual(facts?.height, 48);
});

test('ffmpeg stderr：没有输入行 / 只有音频流时不硬造事实', () => {
  assert.strictEqual(FfmpegStderrParser.parse('ffmpeg version 7.1\n'), undefined);
  const audioOnly = `Input #0, wav, from 'a.wav':\n  Duration: 00:00:01.00, bitrate: 128 kb/s\n  Stream #0:0: Audio: pcm_s16le, 44100 Hz, mono\n`;
  const facts = FfmpegStderrParser.parse(audioOnly);
  assert.ok(facts !== undefined);
  assert.strictEqual(facts.durationMs, 1000, '时长仍可读');
  assert.strictEqual(facts.codec, undefined, '音频编码不得被当成视频编码');
  assert.strictEqual(facts.width, undefined);
  assert.strictEqual(facts.frameRate, undefined);
});

test('ffprobe JSON：字段齐全时全量映射，时长取 format 优先', () => {
  const json = JSON.stringify({
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width: 160,
        height: 120,
        avg_frame_rate: '10/1',
        r_frame_rate: '30000/1001',
        nb_frames: '30',
      },
    ],
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '3.000000', nb_streams: 1 },
  });
  const facts = FfprobeJsonParser.parse(json);
  assert.ok(facts !== undefined);
  assert.strictEqual(facts.container, 'mov,mp4,m4a,3gp,3g2,mj2');
  assert.strictEqual(facts.codec, 'h264');
  assert.strictEqual(facts.width, 160);
  assert.strictEqual(facts.height, 120);
  assert.strictEqual(facts.durationMs, 3000);
  assert.strictEqual(facts.frameCount, 30, '优先取 nb_frames');
  assert.strictEqual(facts.frameRate, 10, '优先取 avg_frame_rate');
});

test('ffprobe JSON：缺 nb_frames 时按时长 × 帧率推算；缺时长则不推算', () => {
  const base = {
    streams: [
      { codec_type: 'video', codec_name: 'vp9', width: 64, height: 64, avg_frame_rate: '25/1' },
    ],
  };
  const withDuration = FfprobeJsonParser.parse(
    JSON.stringify({ ...base, format: { duration: '2.000000' } }),
  );
  assert.strictEqual(withDuration?.frameCount, 50);
  const withoutDuration = FfprobeJsonParser.parse(JSON.stringify(base));
  assert.strictEqual(withoutDuration?.durationMs, undefined);
  assert.strictEqual(withoutDuration?.frameCount, undefined, '缺时长时不得用默认值冒充');
});

test('ffprobe JSON：无视频流 / 非 JSON / 空分母帧率都返回 undefined（fail-closed）', () => {
  assert.strictEqual(
    FfprobeJsonParser.parse(JSON.stringify({ streams: [{ codec_type: 'audio' }] })),
    undefined,
  );
  assert.strictEqual(FfprobeJsonParser.parse('not json at all'), undefined);
  assert.strictEqual(FfprobeJsonParser.parse('[]'), undefined);
  const zeroDenominator = FfprobeJsonParser.parse(
    JSON.stringify({ streams: [{ codec_type: 'video', avg_frame_rate: '10/0' }] }),
  );
  assert.strictEqual(zeroDenominator?.frameRate, undefined, '分母为 0 不得算出 Infinity');
});
