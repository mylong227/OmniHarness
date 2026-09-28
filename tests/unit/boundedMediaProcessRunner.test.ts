import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedMediaProcessRunner } from '../../src/adapters/media/boundedMediaProcessRunner.js';
import type {
  MediaProcessOutcome,
  MediaProcessRequest,
  MediaProcessRunner,
} from '../../src/adapters/media/mediaProcessRunner.js';

/** 记录峰值并发、并在延时后回传固定结果的假执行器。 */
class FakeRunner implements MediaProcessRunner {
  /** 当前在跑数。 */
  public active = 0;
  /** 观测到的峰值并发。 */
  public peak = 0;
  /** 总调用次数。 */
  public calls = 0;

  /**
   * @param delayMs 模拟子进程耗时。
   * @param tag 回传内容标记（用于区分不同实例）。
   */
  public constructor(
    private readonly delayMs: number,
    private readonly tag: string,
  ) {}

  /**
   * 执行一次（记录并发并在延时后回传）。
   *
   * @param _request 未使用。
   * @returns 固定结果。
   */
  public run(_request: MediaProcessRequest): Promise<MediaProcessOutcome> {
    this.calls += 1;
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    return new Promise<MediaProcessOutcome>((resolve) => {
      setTimeout(() => {
        this.active -= 1;
        resolve({
          exitCode: 0,
          stdout: Buffer.from(this.tag),
          stderr: '',
          timedOut: false,
          truncated: false,
          spawnError: undefined,
        });
      }, this.delayMs);
    });
  }
}

/** 必然 reject 的假执行器（用于验证「外层永不把异常漏给调用方」）。 */
class ThrowingRunner implements MediaProcessRunner {
  /**
   * @param _request 未使用。
   * @returns 永不 resolve、必 reject。
   */
  public run(_request: MediaProcessRequest): Promise<MediaProcessOutcome> {
    return Promise.reject(new Error('inner boom'));
  }
}

test('有界并发：峰值并发永不超过上限，且全部请求都能完成', async () => {
  const fake = new FakeRunner(15, 'ok');
  const bounded = new BoundedMediaProcessRunner(fake, 2);
  const request: MediaProcessRequest = {
    command: 'ffmpeg',
    args: [],
    timeoutMs: 1000,
    maxOutputBytes: 1024,
  };
  const outcomes = await Promise.all(Array.from({ length: 6 }, () => bounded.run({ ...request })));
  assert.strictEqual(outcomes.length, 6, '6 个请求都应拿到结果');
  assert.strictEqual(fake.peak <= 2, true, `峰值并发不得超上限（实测 ${String(fake.peak)}）`);
  assert.strictEqual(fake.peak, 2, '6 个并发、上限 2，应稳定触达上限 2（而非退化为 1）');
  assert.strictEqual(fake.calls, 6, '每个请求都要真正派发到内层');
  assert.ok(
    outcomes.every((o) => o.exitCode === 0 && o.spawnError === undefined),
    '全部成功、无 spawnError',
  );
});

test('有界并发：上限 < 1 被收敛为 1（串行），且仍全部完成', async () => {
  const fake = new FakeRunner(10, 'serial');
  const bounded = new BoundedMediaProcessRunner(fake, 0);
  const request: MediaProcessRequest = {
    command: 'ffmpeg',
    args: [],
    timeoutMs: 1000,
    maxOutputBytes: 1024,
  };
  const outcomes = await Promise.all(Array.from({ length: 4 }, () => bounded.run({ ...request })));
  assert.strictEqual(outcomes.length, 4, '4 个请求都应完成');
  assert.strictEqual(
    fake.peak <= 1,
    true,
    `上限收敛为 1 后峰值不得超 1（实测 ${String(fake.peak)}）`,
  );
});

test('有界并发：内层意外 reject 被兜底成 spawnError，外层 Promise 不破', async () => {
  const bounded = new BoundedMediaProcessRunner(new ThrowingRunner(), 2);
  const request: MediaProcessRequest = {
    command: 'ffmpeg',
    args: [],
    timeoutMs: 1000,
    maxOutputBytes: 1024,
  };
  // 若外层把异常漏出，这里 await 会抛——测试即失败。
  const outcome = await bounded.run(request);
  assert.strictEqual(outcome.exitCode, null, '异常兜底为「未启动」形态');
  assert.ok(outcome.spawnError?.includes('inner boom'), `错误信息应透传（${outcome.spawnError}）`);
});
