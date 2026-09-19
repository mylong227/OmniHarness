/**
 * uv 定位器单测（FR-②：`NativeExecutor` 的「装了却判不可用」缺口）。
 *
 * 覆盖四件在生产上真会出问题的事：
 * 1. **显式优先**：`OMNI_UV` 指到哪就用哪（官方脚本装在 `~/.local/bin`，默认不在 PATH 上）；
 * 2. **PATH 扫描**：按平台取 `uv.exe` / `uv` 名字；
 * 3. **已知安装位置兜底**：PATH 里没有时仍能找到 `~/.local/bin/uv`；
 * 4. **缺失可诊断**：找不到时 `searched` 必须非空且列出真实候选（否则报错无从下手）。
 *
 * 另含生产接线断言：`NativeExecutor` 在 uv 缺失时**不抛异常**，而是 fail-closed 返回
 * `resolved:false` 且 reason 带「已查找」与 `OMNI_UV` 出口。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { UvLocator } from '../../src/eval/uvLocator.js';
import { NativeExecutor } from '../../src/eval/nativeExecutor.js';
import type { VerifiedTask } from '../../src/eval/swebenchVerified.js';

/** 造一个「只有这些路径存在」的假文件系统。 */
function fakeFs(existing: readonly string[]): (path: string) => boolean {
  const set = new Set(existing);
  return (path: string): boolean => set.has(path);
}

/** 造一个最小任务（uv 检查在 git 检查之后、任何真实克隆之前，故不会触网）。 */
function task(overrides: Partial<VerifiedTask> = {}): VerifiedTask {
  return {
    id: 'acme__lib-1',
    repo: 'acme/lib',
    baseCommit: 'deadbeef',
    problemStatement: '修一个 bug',
    goldPatch: '',
    testPatch: '',
    failToPass: ['tests/test_a.py::test_x'],
    passToPass: [],
    version: '1.0',
    ...overrides,
  };
}

test('UvLocator：OMNI_UV 显式指定优先于 PATH 与已知位置', () => {
  const lookup = UvLocator.locate({
    env: { OMNI_UV: 'D:\\tools\\uv.exe', PATH: 'D:\\pathbin' },
    platform: 'win32',
    exists: fakeFs(['D:\\tools\\uv.exe', 'D:\\pathbin\\uv.exe']),
  });
  assert.strictEqual(lookup.executable, 'D:\\tools\\uv.exe');
  assert.ok(
    lookup.searched.includes('D:\\tools\\uv.exe'),
    '显式路径也要出现在 searched 里（诊断口径统一）',
  );
});

test('UvLocator：OMNI_UV 指向不存在的位置时继续往后找（不因显式配置错误而整体判死）', () => {
  const lookup = UvLocator.locate({
    env: { OMNI_UV: 'D:\\nope\\uv.exe', PATH: 'D:\\pathbin' },
    platform: 'win32',
    exists: fakeFs(['D:\\pathbin\\uv.exe']),
  });
  assert.strictEqual(lookup.executable, 'D:\\pathbin\\uv.exe');
});

test('UvLocator：PATH 扫描按平台取可执行文件名', () => {
  const win = UvLocator.locate({
    env: { PATH: 'C:\\a;C:\\b' },
    platform: 'win32',
    exists: fakeFs(['C:\\b\\uv.exe']),
  });
  assert.strictEqual(win.executable, 'C:\\b\\uv.exe');
  const posix = UvLocator.locate({
    env: { PATH: '/usr/bin:/opt/bin', HOME: '/home/u' },
    platform: 'linux',
    exists: fakeFs(['/opt/bin/uv']),
  });
  assert.strictEqual(posix.executable, '/opt/bin/uv');
});

test('UvLocator：PATH 里没有时，已知安装位置兜底（本机真实现场）', () => {
  const lookup = UvLocator.locate({
    env: { PATH: '', USERPROFILE: 'C:\\Users\\me' },
    platform: 'win32',
    exists: fakeFs(['C:\\Users\\me\\.local\\bin\\uv.exe']),
  });
  assert.strictEqual(lookup.executable, 'C:\\Users\\me\\.local\\bin\\uv.exe');
});

test('UvLocator：全都找不到 ⇒ executable=null 且 searched 非空（诊断可执行）', () => {
  const lookup = UvLocator.locate({
    env: { PATH: 'C:\\a', USERPROFILE: 'C:\\Users\\me' },
    platform: 'win32',
    exists: () => false,
  });
  assert.strictEqual(lookup.executable, null);
  assert.ok(lookup.searched.length >= 5, `候选位置须成列，实际 ${lookup.searched.length}`);
  assert.ok(
    lookup.searched.some((p) => p.endsWith('uv.exe')),
    '候选须含平台可执行名',
  );
});

test('UvLocator：真机不变量——返回 null 当且仅当所有候选都不存在', () => {
  const lookup = UvLocator.locate();
  if (lookup.executable === null) {
    for (const candidate of lookup.searched) {
      assert.ok(!existsSync(candidate), `候选存在却未命中：${candidate}`);
    }
  } else {
    assert.ok(existsSync(lookup.executable), '命中的路径必须真实存在');
  }
});

test('NativeExecutor 接线：uv 缺失 ⇒ fail-closed（不抛）且报错带已查找位置与 OMNI_UV 出口', async () => {
  const executor = new NativeExecutor({
    repoCacheRoot: 'D:\\nonexistent-cache',
    uvLocator: () => ({
      executable: null,
      searched: ['D:\\path\\uv.exe', 'D:\\home\\.local\\bin\\uv.exe'],
    }),
  });
  assert.match(executor.describe(), /uv=缺少/, 'describe() 必须如实暴露 uv 状态');
  const result = await executor.run(task(), '');
  assert.strictEqual(result.resolved, false);
  assert.match(result.reason ?? '', /uv 不可用/);
  assert.match(result.reason ?? '', /已查找：/);
  assert.match(result.reason ?? '', /D:\\home\\\.local\\bin\\uv\.exe/, '须列出真实找过的位置');
  assert.match(result.reason ?? '', /OMNI_UV/, '须给出可执行出口');
});

test('NativeExecutor 接线：uv 找到 ⇒ describe() 暴露其绝对路径（不再是「不可用」）', async () => {
  const executor = new NativeExecutor({
    uvLocator: () => ({ executable: 'D:\\tools\\uv.exe', searched: ['D:\\tools\\uv.exe'] }),
  });
  assert.match(executor.describe(), /uv=D:\\tools\\uv\.exe/);
});
