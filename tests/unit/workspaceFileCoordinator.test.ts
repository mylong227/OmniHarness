/**
 * 工作区文件协调器判据（真文件、真并发、真跨进程）。
 *
 * 覆盖的五类失败面，每一类都能在旧实现上复现：
 * 1. 同进程两个会话同时写同一文件 ⇒ 后写者静默覆盖（现在：等锁期间被改 ⇒ 拒绝）；
 * 2. 会话 A 读、B 写、A 再写 ⇒ A 拿全局账本绕过（现在：按会话基线拒绝）；
 * 3. 两个会话同时改文件的不同位置 ⇒ 后写者被迫重读（现在：内容锚点未动 ⇒ 自动合并）；
 * 4. 两个进程同时读—改—写 ⇒ 丢一次自增（现在：跨进程租约 + 原子写）；
 * 5. 多文件补丁反向加锁 ⇒ 死锁（现在：绝对路径排序后一次性持有）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WorkspaceFileCoordinator } from '../../src/adapters/tool/fs/workspaceFileCoordinator.ts';
import { ReadFileTool } from '../../src/adapters/tool/fs/readFileTool.ts';
import { WriteFileTool } from '../../src/adapters/tool/fs/writeFileTool.ts';
import { EditFileTool } from '../../src/adapters/tool/fs/editFileTool.ts';
import type { ToolContext } from '../../src/ports/tool/tool.ts';

/** 工具上下文（sessionId 决定版本基线归属）。 */
const ctxOf = (root: string, sessionId = 's1'): ToolContext => ({ sessionId, workspaceRoot: root });

/** 等到条件成立（有界轮询；避免用固定 sleep 赌时序）。 */
async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 在临时工作区内执行并在收尾时清掉协调器缓存。 */
async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'omni-coord-'));
  try {
    return await fn(dir);
  } finally {
    WorkspaceFileCoordinator.forget(dir);
    await rm(dir, { recursive: true, force: true });
  }
}

/** 可手动兑现的闸门。 */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('① 读读并行：两个读租约可同时持锁（写者才需要等）', async () => {
  await withTemp(async (dir) => {
    const file = join(dir, 'a.txt');
    await writeFile(file, 'content', 'utf8');
    const coordinator = WorkspaceFileCoordinator.of(dir);
    const gate = deferred();
    const secondGate = deferred();
    let firstStarted = false;
    let secondStarted = false;
    const first = coordinator.withRead(file, async (lease) => {
      firstStarted = true;
      await gate.promise;
      return lease.readText();
    });
    await until(() => firstStarted);
    const second = coordinator.withRead(file, async (lease) => {
      secondStarted = true;
      await secondGate.promise;
      return lease.readText();
    });
    await until(() => secondStarted);
    assert.strictEqual(
      coordinator.stats().locks.readers >= 2,
      true,
      `两个读必须重叠持有（实测 readers=${coordinator.stats().locks.readers}）`,
    );
    gate.resolve();
    secondGate.resolve();
    assert.deepEqual(await Promise.all([first, second]), ['content', 'content']);
  });
});

test('② 写写互斥、异文件并行：同路径第二个写者必须等第一个释放', async () => {
  await withTemp(async (dir) => {
    const file = join(dir, 'a.txt');
    const other = join(dir, 'b.txt');
    const coordinator = WorkspaceFileCoordinator.of(dir);
    const gate = deferred();
    let firstStarted = false;
    let secondStarted = false;
    const first = coordinator.withWrite(file, async (lease) => {
      firstStarted = true;
      await gate.promise;
      await lease.write('A');
    });
    await until(() => firstStarted);
    const second = coordinator.withWrite(file, async (lease) => {
      secondStarted = true;
      return lease.read();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(secondStarted, false, '同路径写者不得与第一个写者重叠');
    assert.strictEqual(
      await coordinator.withWrite(other, async () => 'ok'),
      'ok',
      '异文件应能并行',
    );
    gate.resolve();
    await first;
    assert.strictEqual(await second, 'A');
  });
});

test('③ 跨会话陈旧读：A 读、B 写、A 再写必须拒绝（旧全局账本会放行）', async () => {
  await withTemp(async (dir) => {
    const file = join(dir, 'a.ts');
    await writeFile(file, 'base\n', 'utf8');
    const coordinator = WorkspaceFileCoordinator.of(dir);
    const reader = new ReadFileTool();
    const writerA = new WriteFileTool(dir);
    const writerB = new WriteFileTool(dir);
    const read = await reader.handle(
      { id: 'r1', name: 'read_file', arguments: { path: 'a.ts' } },
      ctxOf(dir, 'session-A'),
    );
    assert.strictEqual(read.ok, true);
    const wroteB = await writerB.handle(
      { id: 'w1', name: 'write_file', arguments: { path: 'a.ts', content: 'other\n' } },
      ctxOf(dir, 'session-B'),
    );
    assert.strictEqual(wroteB.ok, true);
    const stale = await writerA.handle(
      { id: 'w2', name: 'write_file', arguments: { path: 'a.ts', content: 'mine\n' } },
      ctxOf(dir, 'session-A'),
    );
    assert.strictEqual(stale.ok, false, 'A 的基线已过期，覆盖必须被拒绝');
    assert.match(stale.error ?? '', /read_file/, '错误必须告诉模型先重读');
    assert.strictEqual(await readFile(file, 'utf8'), 'other\n', 'B 的内容不得被 A 覆盖');
    assert.strictEqual(coordinator.ledger.ownerCountOf(file) >= 1, true);
  });
});

test('④ 等锁期间的并发写：两个 write_file 同时到达只能一个成功', async () => {
  await withTemp(async (dir) => {
    const file = join(dir, 'a.ts');
    await writeFile(file, 'base', 'utf8');
    const coordinator = WorkspaceFileCoordinator.of(dir);
    const gate = deferred();
    let holderStarted = false;
    const holder = coordinator.withWrite(file, async (lease) => {
      holderStarted = true;
      await gate.promise;
      await lease.write('A');
    });
    await until(() => holderStarted);
    const contender = new WriteFileTool(dir).handle(
      { id: 'w', name: 'write_file', arguments: { path: 'a.ts', content: 'B' } },
      ctxOf(dir, 'session-X'),
    );
    await until(() => coordinator.stats().locks.waiters >= 1);
    gate.resolve();
    await holder;
    const result = await contender;
    assert.strictEqual(result.ok, false, '等锁期间文件已变，后写者必须失败');
    assert.match(result.error ?? '', /其他会话\/进程修改/);
    assert.strictEqual(await readFile(file, 'utf8'), 'A', '先写者的内容不得被覆盖');
  });
});

test('⑤ 不同位置的并发编辑：锚点未被触碰 ⇒ 自动合并并保留双方改动', async () => {
  await withTemp(async (dir) => {
    const file = join(dir, 'a.ts');
    await writeFile(file, 'line1\nline2\nline3\n', 'utf8');
    const coordinator = WorkspaceFileCoordinator.of(dir);
    const gate = deferred();
    let holderStarted = false;
    const holder = coordinator.withWrite(file, async (lease) => {
      holderStarted = true;
      await gate.promise;
      await lease.write('line1\nline2\nline3-other\n');
    });
    await until(() => holderStarted);
    const edit = new EditFileTool(dir).handle(
      {
        id: 'e',
        name: 'edit',
        arguments: { path: 'a.ts', old_string: 'line2', new_string: 'line2-mine' },
      },
      ctxOf(dir, 'session-M'),
    );
    await until(() => coordinator.stats().locks.waiters >= 1);
    gate.resolve();
    await holder;
    const result = await edit;
    assert.strictEqual(result.ok, true, `锚点仍在，应自动合并：${result.error ?? ''}`);
    assert.match(result.output ?? '', /自动合并/);
    assert.strictEqual(
      await readFile(file, 'utf8'),
      'line1\nline2-mine\nline3-other\n',
      '双方改动都必须保留',
    );
  });
});

test('⑥ 锚点被并发改掉：拒绝而不是改错位置', async () => {
  await withTemp(async (dir) => {
    const file = join(dir, 'a.ts');
    await writeFile(file, 'const a = 1;\n', 'utf8');
    const coordinator = WorkspaceFileCoordinator.of(dir);
    const gate = deferred();
    let holderStarted = false;
    const holder = coordinator.withWrite(file, async (lease) => {
      holderStarted = true;
      await gate.promise;
      await lease.write('const a = 9;\n');
    });
    await until(() => holderStarted);
    const edit = new EditFileTool(dir).handle(
      {
        id: 'e',
        name: 'edit',
        arguments: { path: 'a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' },
      },
      ctxOf(dir, 'session-M'),
    );
    await until(() => coordinator.stats().locks.waiters >= 1);
    gate.resolve();
    await holder;
    const result = await edit;
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /锚点|唯一命中/);
    assert.strictEqual(await readFile(file, 'utf8'), 'const a = 9;\n', '不得写入错误替换');
  });
});

test('⑦ 多文件锁按路径排序：反向申请不会死锁', async () => {
  await withTemp(async (dir) => {
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.txt');
    await writeFile(a, '', 'utf8');
    await writeFile(b, '', 'utf8');
    const coordinator = WorkspaceFileCoordinator.of(dir);
    const gate = deferred();
    let firstStarted = false;
    let secondStarted = false;
    const first = coordinator.withWriteMany([a, b], async () => {
      firstStarted = true;
      await gate.promise;
    });
    await until(() => firstStarted);
    const second = coordinator.withWriteMany([b, a], async () => {
      secondStarted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.strictEqual(secondStarted, false, '第二组必须排在已持有的第一组之后');
    gate.resolve();
    await Promise.all([first, second]);
    assert.strictEqual(secondStarted, true);
  });
});

test('⑧ 原子写：并发读者只会看到旧完整内容或新完整内容', async () => {
  await withTemp(async (dir) => {
    const file = join(dir, 'big.txt');
    const versions = Array.from({ length: 12 }, (_, i) => `v${String(i)}|` + 'x'.repeat(120_000));
    await writeFile(file, versions[0] ?? '', 'utf8');
    const coordinator = WorkspaceFileCoordinator.of(dir);
    const allowed = new Set(versions);
    const writer = coordinator.withWrite(file, async (lease) => {
      for (const version of versions) {
        await lease.write(version);
      }
    });
    const readers = Array.from({ length: 8 }, async () => {
      for (let i = 0; i < 40; i += 1) {
        const text = await coordinator.readText(file);
        assert.strictEqual(
          allowed.has(text),
          true,
          `读者读到了半截/未登记内容（长度 ${String(text.length)}）`,
        );
      }
    });
    await Promise.all([writer, ...readers]);
  });
});

test('⑨ 真·跨进程：两个 Node 进程各做 5 次读—改—写，10 次自增一次不丢', async () => {
  await withTemp(async (dir) => {
    const file = join(dir, 'counter.json');
    await writeFile(file, JSON.stringify({ n: 0 }), 'utf8');
    const url = pathToFileURL(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'src',
        'adapters',
        'tool',
        'fs',
        'workspaceFileCoordinator.ts',
      ),
    ).href;
    const script = `
import { WorkspaceFileCoordinator } from ${JSON.stringify(url)};
const root = ${JSON.stringify(dir)};
const file = ${JSON.stringify(file)};
const coordinator = WorkspaceFileCoordinator.of(root, {
  writeWaitMs: 10_000,
  processWaitMs: 10_000,
  leaseMs: 30_000,
});
for (let i = 0; i < 5; i += 1) {
  await coordinator.withWrite(file, async (lease) => {
    const current = JSON.parse((await lease.read()) ?? '{"n":0}');
    await new Promise((resolve) => setTimeout(resolve, 8));
    await lease.write(JSON.stringify({ n: current.n + 1 }));
  });
}
process.exit(0);
`;
    const run = (): Promise<number> =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--experimental-transform-types', '--input-type=module', '-e', script],
          { stdio: 'ignore', windowsHide: true },
        );
        child.on('error', reject);
        child.on('exit', (code) => resolve(code ?? -1));
      });
    assert.deepEqual(await Promise.all([run(), run()]), [0, 0], '两个子进程都必须正常退出');
    const final = JSON.parse(await readFile(file, 'utf8')) as { n: number };
    assert.strictEqual(final.n, 10, `跨进程十次自增必须全部落地（实测 ${String(final.n)}）`);
    const lockDir = join(dir, '.omniharness', 'locks');
    const leftovers = (await readdir(lockDir)).filter((name) => name.endsWith('.lock'));
    assert.deepEqual(leftovers, [], '收尾不得留下未释放的锁目录');
  });
});

test('⑩ 冲突文案包含版本差异与下一步动作', async () => {
  await withTemp(async (dir) => {
    const file = join(dir, 'a.ts');
    await writeFile(file, 'one\ntwo\n', 'utf8');
    const coordinator = WorkspaceFileCoordinator.of(dir);
    const gate = deferred();
    let holderStarted = false;
    const holder = coordinator.withWrite(file, async (lease) => {
      holderStarted = true;
      await gate.promise;
      await lease.write('one\nTWO-LONGER\n');
    });
    await until(() => holderStarted);
    const contender = new WriteFileTool(dir).handle(
      { id: 'w', name: 'write_file', arguments: { path: 'a.ts', content: 'x' } },
      ctxOf(dir, 'session-X'),
    );
    await until(() => coordinator.stats().locks.waiters >= 1);
    gate.resolve();
    await holder;
    const result = await contender;
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /第 2 行起|行/);
  });
});

test('⑪ 锁目录在 .omniharness/locks 下，不污染工作区文件', async () => {
  await withTemp(async (dir) => {
    const file = join(dir, 'a.txt');
    const coordinator = WorkspaceFileCoordinator.of(dir);
    await coordinator.withWrite(file, async (lease) => {
      await lease.write('x');
    });
    await mkdir(join(dir, '.omniharness', 'locks'), { recursive: true });
    const names = await readdir(dir);
    assert.deepEqual(
      names.filter((name) => name.endsWith('.lock')),
      [],
      '工作区根不得出现 <file>.lock',
    );
    assert.strictEqual(await readFile(file, 'utf8'), 'x');
  });
});

test('⑫ 读单飞：同一路径的并发读共享一次在飞 IO', async () => {
  await withTemp(async (dir) => {
    const file = join(dir, 'a.txt');
    await writeFile(file, 'shared-content', 'utf8');
    const coordinator = WorkspaceFileCoordinator.of(dir);
    const first = coordinator.readText(file);
    const second = coordinator.readText(file);
    assert.strictEqual(
      coordinator.stats().inflightReads,
      1,
      `两个并发读应共享同一个在飞 Promise（实测 ${String(coordinator.stats().inflightReads)}）`,
    );
    assert.deepEqual(await Promise.all([first, second]), ['shared-content', 'shared-content']);
    assert.strictEqual(coordinator.stats().inflightReads, 0, '读完成后必须清掉在飞表');
  });
});
