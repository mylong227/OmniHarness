/**
 * ChromeProcess 启动失败路径的**回收**回归（2026-09-26 审计 S10）。
 *
 * 旧实现：`awaitDevToolsUrl(child)` 抛出（启动超时 / 浏览器提前退出）时**什么都不做**——
 *  Chromium 子进程成孤儿、stdio 管道仍被引用（把宿主钉住不退出）、`this.child` 不复位
 *  ⇒ 之后每次 `launch()` 都抛「浏览器已在启动中」，而 `process.once('exit')` 兜底钩子
 *  此时**还没注册**（它排在 await 之后）。
 *
 * 本用例用一个**必然快速退出**的可执行文件（node 收到 Chromium 旗标即报 bad option 退出）
 * 触发失败路径，断言：① 首次启动如实失败；② 失败后 `this.child` 已复位——再次 launch()
 * 得到的是**同一个真实原因**，而不是「浏览器已在启动中」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChromeProcess } from '../../src/adapters/browser/chromeProcess.js';

test('ChromeProcess：启动失败必须回收——再次 launch 不得报「已在启动中」', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'omni-chrome-cleanup-'));
  try {
    const proc = new ChromeProcess({
      // node 会把 `--headless=new` 当未知选项并立即退出 ⇒ 必然走失败路径。
      executable: process.execPath,
      userDataDir,
      launchTimeoutMs: 5_000,
    });
    await assert.rejects(() => proc.launch(), '首次启动应如实失败');
    await assert.rejects(
      () => proc.launch(),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.ok(
          !message.includes('已在启动中'),
          `子进程句柄未复位，第二次 launch 得到的是伪错误：「${message}」`,
        );
        return true;
      },
      '第二次 launch 应给出真实原因',
    );
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('ChromeProcess：kill 幂等（未启动 / 重复调用都不抛）', () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'omni-chrome-cleanup-'));
  try {
    const proc = new ChromeProcess({ executable: process.execPath, userDataDir });
    proc.kill();
    proc.kill();
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
