// 浏览器子进程**树**终止回归（2026-09-27 实测的孤儿进程泄漏）。
//
// ## 缺陷形态（真实，非假想）
//
// `launchChromeForCdp` 在 Windows 上拿到的 pid 是 Chrome 的**启动器**，真正的浏览器是它的子进程；
// 各用例收尾写的 `proc.kill('SIGKILL')` 只杀启动器 ⇒ 浏览器 + 它的 `--type=renderer|gpu-process|…`
// 子进程**全部留下**且不会自杀。逐次实测：kill 前该 user-data-dir 下 11 个 chrome.exe，
// `child.kill('SIGKILL')` 后**残留 10 个**；`taskkill /PID <pid> /T /F` 后**残留 0**。
// 反复跑集成/浏览器用例几分钟内堆到 **75 个进程 / ~4GB**（16GB 机器一度只剩 559MB 可用），
// 既拖慢后续用例，也让「偶发失败」失去可归因性（board §22.9 登记的那条 flake 正在此列）。
//
// ## 判据（可证伪）
//
// 起真 Chrome（CDP 路线）→ `killChromeTree` → 轮询该 `--user-data-dir` 的进程数必须归零，
// 且 profile 目录能立刻删掉（同步 taskkill 的收益）。**Windows 上断言零残留**；POSIX 上只断言
// 「我们 spawn 的那个进程没了」——Linux/macOS 的 Chrome 不做 Windows 那种启动器再 spawn，
// 我们的单进程 kill 已足够，且不引入 `ps` 解析的平台脆弱性。
//
// 无浏览器时显式 skip（不伪装通过）；可用 OMNI_CHROME_PATH 指定。
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findBrowser,
  getFreePort,
  launchChromeForCdp,
  killChromeTree,
  waitForPageWs,
} from './browserHarness.mjs';

/**
 * 列出命令行包含 `marker` 的进程（仅用于断言「该 user-data-dir 下没有 Chrome 残留」）。
 * @param {string} marker 命令行子串（这里用独一无二的临时 user-data-dir 路径）
 * @returns {string[]} 命中的进程标识（pid）列表
 */
function procsWithMarker(marker) {
  if (process.platform === 'win32') {
    const script =
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | " +
      'Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';
    let raw = '';
    try {
      raw = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    } catch {
      return [];
    }
    const trimmed = raw.trim();
    if (trimmed === '') return [];
    const parsed = JSON.parse(trimmed);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .filter((p) => String(p.CommandLine ?? '').includes(marker))
      .map((p) => String(p.ProcessId));
  }
  try {
    const raw = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
    return raw
      .split('\n')
      .filter((line) => line.includes(marker))
      .map((line) => line.trim().split(/\s+/)[0]);
  } catch {
    return [];
  }
}

/** 轮询直到谓词为真或超时。 */
async function until(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`超时等待：${label}（最后结果：${JSON.stringify(last)}）`);
}

test('浏览器收尾必须终止整棵 Chrome 进程树（只 kill 启动器会留下 10 个子进程）', async (t) => {
  const browser = findBrowser();
  if (!browser) {
    t.skip('未找到本机 Chrome/Edge；设 OMNI_CHROME_PATH 后重跑');
    return;
  }

  const userDataDir = mkdtempSync(join(tmpdir(), 'omni-chrome-tree-'));
  const port = await getFreePort();
  const proc = launchChromeForCdp(browser, 'about:blank', userDataDir, port);
  try {
    await waitForPageWs(port, 'about:blank', 30_000);
    // 等子进程树长起来（渲染/gpu/network 都是启动后才 spawn 的）。
    await until(() => procsWithMarker(userDataDir).length >= 1, 15_000, 'Chrome 进程就位');
    const live = procsWithMarker(userDataDir);
    // 「启动器 + 真浏览器为子进程」这一结构是 Windows 实测的；POSIX 只要求主进程在线，
    // 避免把平台差异写成断言（那会在 ubuntu CI 上假红）。
    const minLive = process.platform === 'win32' ? 2 : 1;
    assert.ok(
      live.length >= minLive,
      `异常前提：该 user-data-dir 下只有 ${live.length} 个进程（阈值 ${minLive}），测不出「树」终止（环境异常，非通过）`,
    );
  } finally {
    killChromeTree(proc, userDataDir);
  }

  await until(
    () => procsWithMarker(userDataDir).length === 0,
    15_000,
    'killChromeTree 后该 user-data-dir 下不得有 Chrome 残留',
  );
  // 同步终止的附带收益：profile 目录当场可删（此前异步 kill + 锁未释放 ⇒ rmSync 撞 EBUSY）。
  rmSync(userDataDir, { recursive: true, force: true });
  assert.strictEqual(procsWithMarker(userDataDir).length, 0, '清理后仍应有零残留');
});
