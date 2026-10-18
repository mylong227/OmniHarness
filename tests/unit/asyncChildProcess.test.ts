import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AsyncChildProcess } from '../../src/util/asyncChildProcess.ts';

const NODE = process.execPath;

test('input 真的写进 stdin（不是只塞进 spawn options）', async () => {
  const out = await AsyncChildProcess.execFileAsync(
    NODE,
    ['-e', 'process.stdin.pipe(process.stdout)'],
    { input: 'hello-stdin' },
  );
  assert.strictEqual(out, 'hello-stdin');
});

test('spawnSyncAsync：无 input 也会关闭 stdin（等待 EOF 的子进程不得挂死）', async () => {
  const result = await AsyncChildProcess.spawnSyncAsync(
    NODE,
    ['-e', "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('eof'))"],
    { encoding: 'utf8' },
  );
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, 'eof');
});

test('输出超 maxBufferBytes ⇒ 强杀并以可读错误 reject（不得静默截断当成功）', async () => {
  await assert.rejects(
    () =>
      AsyncChildProcess.execFileAsync(NODE, ['-e', "process.stdout.write('x'.repeat(2_000_000))"], {
        maxBufferBytes: 1024,
      }),
    /maxBufferBytes/u,
  );
});

test('被信号终止 ⇒ execFileAsync 必须 reject（不得把 status=null 当成功）', async () => {
  await assert.rejects(
    () => AsyncChildProcess.execFileAsync(NODE, ['-e', "process.kill(process.pid, 'SIGTERM')"]),
    /signal|status/u,
  );
});
