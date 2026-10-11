/**
 * 「在途请求表**只有一份实现**」判据（2026-10-11）。
 *
 * ## 为什么需要
 *
 * 审计 §3.5 记过「JSON-RPC pending / 超时 / id→Promise 关联**重复 6 处**，且 `mcpClient.ts`
 * 没有 reject 通道」——重复实现的问题不是"代码难看"，而是**修复不会传播**：给其中一处补了超时、
 * 断开收尾或二次兑现保护，另外几处照旧泄漏/永久挂起。收敛到 `util/concurrency/pendingRequests.ts`
 * 之后，本轮仍抓到**第 7 处漏网**：`codeSandboxWorker` 里手写的 `new Map<seq, resolve>` + 手动 delete
 * （既无超时也无断开通道）。本判据把"唯一实现"变成可核对的事实：
 *
 * ① 全仓只有一个文件声明 `class PendingRequests`；
 * ② 已知的 9 个协议客户端**都**引用了它（含本轮新收口的沙箱 worker）；
 * ③ 检测器本身有**正对照**：喂进"改造前那段手写 Map"必须报违规（否则 ② 的"零违规"可能只是检测器失灵）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（编译产物在 `dist/tests/unit/`）。 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 唯一实现的路径（相对仓库根）。 */
const SINGLE_IMPL = 'src/util/concurrency/pendingRequests.ts';

/** 必须复用唯一实现的协议客户端（含本轮新收口的沙箱 worker）。 */
const CLIENTS = [
  'src/a2a/a2aClient.ts',
  'src/adapters/browser/cdpClient.ts',
  'src/adapters/laya/layaWarmWorker.ts',
  'src/adapters/lsp/lspJsonRpcConnection.ts',
  'src/adapters/tool/code/codeSandboxWorker.ts',
  'src/mcp/mcpClient.ts',
  'src/sdk/sdkClient.ts',
  'src/server/core/serverEventBridge.ts',
  'src/server/transport/httpBridgeTransport.ts',
] as const;

/** 递归收集 src 下的 .ts（非 .d.ts）。 */
function srcFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        out.push(relative(REPO_ROOT, abs).split(sep).join('/'));
      }
    }
  };
  walk(join(REPO_ROOT, 'src'));
  return out.sort();
}

/**
 * 检测「手写的在途请求表」：同一个文件里既有 `new Map<…>`（或 `= new Map(`）出现在名为 pending*
 * 的变量上，又有对它的手工 `delete(` —— 这是本仓收敛前那 7 处的共同形状。
 * @param source 源码文本。
 * @returns 是否命中该形状。
 */
function handRolledPendingTable(source: string): boolean {
  const declaresMap = /(?:const|let|readonly)\s+\w*pending\w*\s*(?::[^=]+)?=\s*new\s+Map</i.test(
    source,
  );
  const manualDelete = /\bpending\w*\.delete\(/i.test(source);
  return declaresMap && manualDelete;
}

test('① 全仓只有一处声明 `class PendingRequests`（唯一实现）', () => {
  const declaring = srcFiles().filter((rel) =>
    /export class PendingRequests\b/.test(readFileSync(join(REPO_ROOT, rel), 'utf8')),
  );
  assert.deepStrictEqual(
    declaring,
    [SINGLE_IMPL],
    `在途请求表的实现必须唯一；这些文件也声明了 PendingRequests：${declaring.join(', ')}`,
  );
});

test('② 已知协议客户端都必须复用唯一实现（不得各自手写表）', () => {
  const offenders: string[] = [];
  for (const rel of CLIENTS) {
    const source = readFileSync(join(REPO_ROOT, rel), 'utf8');
    if (!source.includes('PendingRequests')) {
      offenders.push(`${rel}（未引用唯一实现）`);
      continue;
    }
    if (handRolledPendingTable(source)) {
      offenders.push(`${rel}（同时还有手写 Map 表）`);
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    `这些客户端没走唯一实现 ⇒ 超时/断开/二次兑现的修复不会传播到它们：\n${offenders.join('\n')}`,
  );
  // 仪器自证：清单里的文件都真实存在（防"路径写错 ⇒ 循环空转 ⇒ 恒绿"）。
  for (const rel of CLIENTS) {
    assert.ok(statSync(join(REPO_ROOT, rel)).isFile(), `清单里的文件不存在：${rel}`);
  }
});

test('③ 检测器正对照：改造前那段手写 Map 必须被判违规（否则②的"零违规"可能只是检测器失灵）', () => {
  const before = [
    'const pending = new Map<number, (message: unknown) => void>();',
    'const resolve = pending.get(seq);',
    'pending.delete(seq);',
  ].join('\n');
  assert.strictEqual(handRolledPendingTable(before), true, '检测器认不出已知的坏形状 ⇒ 判据②恒真');
  const after = readFileSync(
    join(REPO_ROOT, 'src/adapters/tool/code/codeSandboxWorker.ts'),
    'utf8',
  );
  assert.strictEqual(handRolledPendingTable(after), false, '沙箱 worker 应已不含手写 Map 表');
  assert.match(after, /new PendingRequests</, '沙箱 worker 必须改用唯一实现');
});
