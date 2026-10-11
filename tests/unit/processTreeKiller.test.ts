/**
 * `ProcessTreeKiller`（取消 / 超时主链上的**整棵进程树**终止）单测。
 *
 * 此前该文件**零单测 import**，未覆盖的恰好是「分平台回退分支」。本文件的两类判据：
 *
 * 1. **注入缝判据**：`kill` / `killPid` 接受可选 `opts`（缺省即真实平台与真实系统调用），
 *    由此可在本机（win32）直接判定 POSIX 组杀、EPERM/ESRCH 回退、失败静默等分支——
 *    这些分支靠读代码相信是不够的。
 * 2. **真进程判据**：用本机 `process.execPath` 起真子进程，验证「返回即已死」与
 *    「EPERM/ESRCH 不抛错」（终止属收尾路径，不能把已拿到的结果毁掉）。
 *
 * 覆盖面说明：真进程组（`spawn({detached:true})`）用例在本机不跑，见测试
 * `POSIX 进程组回退链` 内的分支注释——win32 上 `child.kill(-pid)` 不可用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { ProcessTreeKiller } from '../../src/adapters/tool/shell/processTreeKiller.js';

/** 真子进程：长眠一小段后自然退出（真 pid、真内核进程对象）。 */
const spawnSleeper = (): ChildProcess =>
  spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);

/** 同步等待，用于给「尚未就绪」的真子进程留出启动时间。 */
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** 判定 pid 是否仍在（ESRCH = 已不在）；只用于**观察**，不参与被测逻辑。 */
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * 轮询等待子进程退出。
 * @param child 真子进程。
 * @param timeoutMs 超时毫秒数。
 * @returns 是否在超时前退出。
 */
const waitExit = async (child: ChildProcess, timeoutMs = 10_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return child.exitCode !== null || child.signalCode !== null;
};

/**
 * 造一个**受控替身**（只实现被测逻辑真正触碰的两个成员：`pid` 与 `kill`）。
 * @param pid `pid` 取值。
 * @param killImpl `kill` 的实现（缺省记录参数并返回 true）。
 * @returns 替身与调用记录。
 */
const makeChild = (
  pid: number | undefined,
  killImpl?: (signal?: NodeJS.Signals | number) => boolean,
): { child: ChildProcess; calls: (NodeJS.Signals | number | undefined)[] } => {
  const calls: (NodeJS.Signals | number | undefined)[] = [];
  const stub = {
    pid,
    kill: (signal?: NodeJS.Signals | number): boolean => {
      if (killImpl !== undefined) return killImpl(signal);
      calls.push(signal);
      return true;
    },
  };
  return { child: stub as unknown as ChildProcess, calls };
};

test('killPid(win32)：同步 taskkill /T /F，参数与 5s 超时上限齐全', () => {
  const calls: { file: string; args: readonly string[]; options: unknown }[] = [];
  const exec = ((file: string, args: readonly string[], options: unknown): string => {
    calls.push({ file, args, options });
    return '';
  }) as unknown as typeof import('node:child_process').execFileSync;

  ProcessTreeKiller.killPid(4242, { platform: 'win32', exec });

  assert.strictEqual(calls.length, 1, 'taskkill 必须恰好执行一次');
  const call = calls[0];
  assert.ok(call !== undefined);
  assert.strictEqual(call.file, 'taskkill');
  // 逐字固定：/T 是「连带后代」的唯一来源，/F 是「强制」，String(pid) 才能带上真 pid。
  assert.deepStrictEqual([...call.args], ['/PID', '4242', '/T', '/F']);
  const options = call.options as { stdio?: unknown; timeout?: unknown };
  // **同步**执行（调用方随后就清工作目录）：stdio 必须 ignore，否则 taskkill 的
  // 输出要么污染 stdout，要么因管道未被读取而阻塞。
  assert.strictEqual(options.stdio, 'ignore');
  assert.strictEqual(options.timeout, 5_000, '必须有超时上限，否则收尾路径可能挂住');
});

test('killPid(win32)：taskkill 抛错（权限不足 / 进程已退出）时不外抛、不越界回退', () => {
  const exec = ((): never => {
    const error: NodeJS.ErrnoException = new Error('access denied');
    error.code = 'EPERM';
    throw error;
  }) as unknown as typeof import('node:child_process').execFileSync;
  const killed: number[] = [];
  const kill = (pid: number): boolean => {
    killed.push(pid);
    return true;
  };

  // 终止属收尾路径：失败必须静默，否则会把已经拿到的结果毁掉。
  assert.doesNotThrow(() => {
    ProcessTreeKiller.killPid(4242, { platform: 'win32', exec, kill });
  });
  // 只持有 pid 时没有 `ChildProcess` 句柄可回退；且**不得**退化成单进程强杀
  // （那会只终结外壳、留下载荷树跑）。
  assert.deepStrictEqual(killed, [], 'win32 分支不得调用单进程 kill');
});

test('killPid(POSIX)：先杀进程组，组杀失败回退单进程', () => {
  const attempts: number[] = [];
  const groupFails = (pid: number): boolean => {
    attempts.push(pid);
    if (pid < 0) {
      const error: NodeJS.ErrnoException = new Error('not permitted');
      error.code = 'EPERM';
      throw error;
    }
    return true;
  };

  ProcessTreeKiller.killPid(4242, { platform: 'linux', kill: groupFails });

  assert.deepStrictEqual(attempts, [-4242, 4242], '必须先 -pid 组杀，失败再回退 +pid');
});

test('killPid(POSIX)：组杀失败后回退再抛（已退出）仍静默', () => {
  const attempts: number[] = [];
  const alwaysFails = (pid: number): boolean => {
    attempts.push(pid);
    const error: NodeJS.ErrnoException = new Error('no such process');
    error.code = 'ESRCH';
    throw error;
  };

  assert.doesNotThrow(() => {
    ProcessTreeKiller.killPid(4242, { platform: 'darwin', kill: alwaysFails });
  });
  assert.deepStrictEqual(attempts, [-4242, 4242]);
});

test('killPid(POSIX)：组杀成功即止，不再补一枪', () => {
  const attempts: number[] = [];
  const groupOk = (pid: number): boolean => {
    attempts.push(pid);
    return true;
  };

  ProcessTreeKiller.killPid(4242, { platform: 'linux', kill: groupOk });

  assert.deepStrictEqual(attempts, [-4242], '组杀成功后不得再多杀一次');
});

test('kill(win32)：spawn taskkill /T /F（windowsHide）并挂 error 回退', () => {
  const spawnCalls: { command: string; args: readonly string[]; options: unknown }[] = [];
  const listeners = new Map<string, (error: Error) => void>();
  const fakeSpawn = ((command: string, args: readonly string[], options: unknown) => {
    spawnCalls.push({ command, args, options });
    return {
      on: (event: string, handler: (error: Error) => void): unknown => {
        listeners.set(event, handler);
        return undefined;
      },
    };
  }) as unknown as typeof import('node:child_process').spawn;
  const { child, calls } = makeChild(777);

  ProcessTreeKiller.kill(child, { platform: 'win32', spawn: fakeSpawn });

  assert.strictEqual(spawnCalls.length, 1);
  const call = spawnCalls[0];
  assert.ok(call !== undefined);
  assert.strictEqual(call.command, 'taskkill');
  assert.deepStrictEqual([...call.args], ['/PID', '777', '/T', '/F']);
  const options = call.options as { windowsHide?: unknown; stdio?: unknown };
  assert.strictEqual(options.windowsHide, true, 'win32 上不得弹出控制台窗口');
  assert.strictEqual(options.stdio, 'ignore');
  assert.strictEqual(listeners.has('error'), true, 'taskkill 起不来时必须仍有回退通道');
  assert.deepStrictEqual(calls, [], '未收到 error 前不得先杀直接子进程');

  // 异步失败事件（taskkill 不在 PATH / 无权限）⇒ 走单进程回退。
  listeners.get('error')?.(new Error('spawn taskkill ENOENT'));
  assert.deepStrictEqual(calls, ['SIGKILL'], 'taskkill 失败必须回退 child.kill(SIGKILL)');
});

test('kill(win32)：spawn 同步抛错（如 EPERM）时回退，且不外抛', () => {
  const fakeSpawn = ((): never => {
    const error: NodeJS.ErrnoException = new Error('spawn EPERM');
    error.code = 'EPERM';
    throw error;
  }) as unknown as typeof import('node:child_process').spawn;
  const { child, calls } = makeChild(777);

  assert.doesNotThrow(() => {
    ProcessTreeKiller.kill(child, { platform: 'win32', spawn: fakeSpawn });
  });
  assert.deepStrictEqual(calls, ['SIGKILL'], '同步抛错同样必须回退单进程 kill');
});

test('kill(win32)：spawn 同步抛错且回退也抛（已退出）时，两层 catch 都静默', () => {
  const fakeSpawn = ((): never => {
    throw new Error('spawn EPERM');
  }) as unknown as typeof import('node:child_process').spawn;
  // 回退也抛：进程在 taskkill 起不来之前就已退出（ESRCH）——收尾路径最真实的竞态。
  const { child } = makeChild(777, () => {
    throw new Error('ESRCH');
  });

  assert.doesNotThrow(() => {
    ProcessTreeKiller.kill(child, { platform: 'win32', spawn: fakeSpawn });
  });
});

test('kill(非 win32)：优先杀进程组（负 pid），成功即止', () => {
  const attempts: number[] = [];
  const kill = (pid: number, signal: NodeJS.Signals | number): boolean => {
    attempts.push(pid);
    assert.strictEqual(signal, 'SIGKILL');
    return true;
  };
  const { child } = makeChild(4242);

  ProcessTreeKiller.kill(child, { platform: 'linux', kill });

  assert.deepStrictEqual(attempts, [-4242], '组杀成功即整组终结，不需要回退');
});

test('kill(非 win32)：组杀抛错（ESRCH / EPERM）时回退单进程且不抛', () => {
  const attempts: number[] = [];
  const kill = (pid: number): boolean => {
    attempts.push(pid);
    const error: NodeJS.ErrnoException = new Error('no such process group');
    error.code = 'ESRCH';
    throw error;
  };
  const { child, calls } = makeChild(4242);

  assert.doesNotThrow(() => {
    ProcessTreeKiller.kill(child, { platform: 'darwin', kill });
  });
  assert.deepStrictEqual(attempts, [-4242]);
  assert.deepStrictEqual(calls, ['SIGKILL'], '组杀失败必须回退单进程，而不是就此放弃');
});

test('kill(非 win32)：注入的组杀失败后回退也抛（已退出）仍静默', () => {
  const kill = (): boolean => {
    const error: NodeJS.ErrnoException = new Error('gone');
    error.code = 'ESRCH';
    throw error;
  };
  const { child } = makeChild(4242, () => {
    throw new Error('child already exited');
  });

  assert.doesNotThrow(() => {
    ProcessTreeKiller.kill(child, { platform: 'linux', kill });
  });
});

test('kill(无 pid)：走单进程 kill，不触碰平台分支', () => {
  const { child, calls } = makeChild(undefined);
  let platformBranchUsed = false;
  const kill = (): boolean => {
    platformBranchUsed = true;
    return true;
  };

  ProcessTreeKiller.kill(child, { platform: 'win32', kill });

  assert.deepStrictEqual(calls, ['SIGKILL']);
  assert.strictEqual(platformBranchUsed, false, '未 spawn 成功时不该走任何平台分支');
});

test('kill(无 pid)：child.kill 抛错（已退出）时静默', () => {
  const { child } = makeChild(undefined, () => {
    throw new Error('ESRCH');
  });

  assert.doesNotThrow(() => {
    ProcessTreeKiller.kill(child);
  });
});

/**
 * 取一个**当前已不存在**的 pid（起一个真子进程、杀干净、等它退出，再读回 pid）。
 * 用于以真实 `process.kill` 验证 ESRCH 静默——这是本机不注入 `opts.kill` 时唯一可达
 * 非 win32 分支的方式（win32 上 `process.kill(-pid)` 会直接抛错）。
 * @returns 已回收的 pid。
 */
const retiredPid = async (): Promise<number> => {
  const child = spawnSleeper();
  const pid = child.pid;
  assert.ok(pid !== undefined, '真子进程必须有 pid');
  child.kill('SIGKILL');
  await waitExit(child);
  return pid;
};

test('kill(非 win32 且不注入 kill)：走真实 process.kill，组杀失败/ERANGE 一律静默', async () => {
  // 真子进程（pid 有效）但**已退出**：负 pid 组杀必然失败 ⇒ 回退 child.kill（此时同样无实体）。
  // 本用例同时证明「不传 opts.kill 时的缺省实现」确实接到了真实 `process.kill` 上。
  const child = spawnSleeper();
  assert.ok(child.pid !== undefined, '真子进程必须有 pid');
  child.kill('SIGKILL');
  await waitExit(child);

  assert.doesNotThrow(() => {
    ProcessTreeKiller.kill(child, { platform: 'linux' });
  });
});

test('killPid(非 win32 且不注入 kill)：真实 process.kill 对已回收 pid 静默', async () => {
  const pid = await retiredPid();

  assert.doesNotThrow(() => {
    ProcessTreeKiller.killPid(pid, { platform: 'linux' });
  });
});

test('真子进程：killPid 后 pid 立即消失（返回即已死，调用方可接着清目录）', () => {
  const child = spawnSleeper();
  const pid = child.pid;
  assert.ok(pid !== undefined, '真子进程必须有 pid');
  try {
    // 留出窗口：若新实现在 win32 上又是「异步 taskkill」，下面的 isAlive 会读到 true。
    sleepSync(250);
    ProcessTreeKiller.killPid(pid);
    assert.strictEqual(isAlive(pid), false, 'killPid 返回后该 pid 必须已不存在');
  } finally {
    if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    child.kill('SIGKILL');
  }
});

test('真子进程：kill 直接子进程后立即失效；对已退出进程重复调用不抛错', async () => {
  const child = spawnSleeper();
  const pid = child.pid;
  assert.ok(pid !== undefined, '真子进程必须有 pid');
  try {
    ProcessTreeKiller.kill(child);
    const exited = await waitExit(child);
    assert.strictEqual(exited, true, 'kill 后子进程应结束');
    // 幂等：已退出再杀一次必须仍然静默（ESRCH 是预期语义，不是错误）。
    assert.doesNotThrow(() => {
      ProcessTreeKiller.kill(child);
    });
    assert.doesNotThrow(() => {
      ProcessTreeKiller.killPid(pid);
    });
  } finally {
    if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    child.kill('SIGKILL');
  }
});

test('POSIX 进程组回退链：注入平台 + 真实的负 pid 组杀，验证整组语义可跑通', async () => {
  if (process.platform === 'win32') {
    // win32 无进程组语义：`child.kill(-pid)` 在 Node 里对负数 pid 直接抛错，
    // detached 子进程也不是「会话组长」。故真进程组只能在本机之外验证。
    return;
  }
  const child = spawn('/bin/sh', ['-c', `${process.execPath} -e "setTimeout(()=>{},60000)"`], {
    detached: true,
  });
  const pid = child.pid;
  assert.ok(pid !== undefined, '真子进程必须有 pid');
  try {
    ProcessTreeKiller.kill(child);
    const exited = await waitExit(child);
    assert.strictEqual(exited, true, '组杀后 shell 应立即结束');
  } finally {
    if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    child.kill('SIGKILL');
  }
});
