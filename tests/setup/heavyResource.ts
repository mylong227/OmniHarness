/**
 * 重判据资源池的 Vitest setup（2026-10-23）。
 *
 * 只对**会 spawn 外部进程**的少数判据加跨进程槽；普通判据仍全速并行。
 * 识别按测试文件路径（`expect.getState().testPath` 在 beforeAll 时已由 runner 设置）。
 * 槽数 `OMNI_HEAVY_SLOTS`（默认 1）。
 */
import { afterAll, beforeAll, expect } from 'vitest';
import { HeavyResourcePool } from '../helpers/heavyResourcePool.ts';

const HEAVY_PATTERN =
  /(?:^|[\\/])(?:pluginWorker|layaWarmWorker|sandbox|codeSandbox)\.test\.ts$|(?:^|[\\/])(?:liveUiE2e|layaBackend|layaCandidateRanking)\.test\.ts$/u;

let release: (() => void) | undefined;

beforeAll(async () => {
  const testPath = expect.getState().testPath ?? '';
  if (!HEAVY_PATTERN.test(testPath)) return;
  if (process.env['OMNI_HEAVY_DEBUG'] === '1') {
    console.error(`[heavy-pool] acquire: ${testPath}`);
  }
  release = await HeavyResourcePool.acquire(testPath);
});

afterAll(() => {
  release?.();
  release = undefined;
});
