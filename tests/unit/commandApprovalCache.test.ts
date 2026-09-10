import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ApprovalDecision, ApprovalPort, ApprovalRequest } from '../../src/ports/approval.js';
import {
  canonicalizeCommand,
  canonicalKeyOf,
  CMD_SCRIPT_MARKER,
  POWERSHELL_SCRIPT_MARKER,
  SHELL_SCRIPT_MARKER,
  tokenizeShell,
} from '../../src/util/commandCanonicalizer.js';
import { CachedApproval } from '../../src/adapters/approval/cachedApproval.js';

/** 计数审批端口：记录被问次数与最后一次请求，可预置裁决。 */
class CountingApproval implements ApprovalPort {
  public readonly name = 'counting';
  public calls = 0;
  public last?: ApprovalRequest;

  public constructor(private readonly decision: ApprovalDecision = 'allow') {}

  public async decide(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.calls += 1;
    this.last = request;
    return this.decision;
  }
}

/** 构造一条 shell 审批请求。 */
function shellRequest(command: string): ApprovalRequest {
  return { sessionId: 's1', toolName: 'shell', target: command };
}

/** 构造一条非 shell 审批请求（按路径入键，不做命令规范化）。 */
function fileRequest(path: string): ApprovalRequest {
  return { sessionId: 's1', toolName: 'write_file', target: path };
}

describe('命令规范化（M4）', () => {
  it('去包装：bash -lc 与 /bin/bash -c 归一为同一 token 序列', () => {
    assert.deepStrictEqual(canonicalizeCommand('bash -lc "ls -la"'), ['ls', '-la']);
    assert.deepStrictEqual(canonicalizeCommand('/bin/bash -c "ls -la"'), ['ls', '-la']);
    assert.deepStrictEqual(canonicalizeCommand("sh -c 'ls -la'"), ['ls', '-la']);
    assert.strictEqual(
      canonicalKeyOf(canonicalizeCommand('bash -lc "ls -la"')),
      canonicalKeyOf(canonicalizeCommand('/bin/bash -c "ls -la"')),
    );
  });

  it('含串联/管道时不拆脚本，降级为标记 + 原文', () => {
    assert.deepStrictEqual(canonicalizeCommand('bash -lc "a && b"'), [
      SHELL_SCRIPT_MARKER,
      'bash',
      'a && b',
    ]);
    assert.deepStrictEqual(canonicalizeCommand('bash -lc "a | b"'), [
      SHELL_SCRIPT_MARKER,
      'bash',
      'a | b',
    ]);
    assert.deepStrictEqual(canonicalizeCommand('bash -lc "a; b"'), [
      SHELL_SCRIPT_MARKER,
      'bash',
      'a; b',
    ]);
  });

  it('PowerShell 与 cmd 包装各归一类', () => {
    assert.deepStrictEqual(canonicalizeCommand('powershell -Command "Get-ChildItem"'), [
      POWERSHELL_SCRIPT_MARKER,
      'Get-ChildItem',
    ]);
    assert.deepStrictEqual(canonicalizeCommand('cmd /c "dir"'), [CMD_SCRIPT_MARKER, 'dir']);
  });

  it('裸命令与引号：引号不进 token，空格内内容保留', () => {
    assert.deepStrictEqual(canonicalizeCommand('git status'), ['git', 'status']);
    assert.deepStrictEqual(canonicalizeCommand('echo "hello world"'), ['echo', 'hello world']);
    assert.deepStrictEqual(canonicalizeCommand(''), []);
  });

  it('tokenizeShell 处理转义与单引号', () => {
    assert.deepStrictEqual(tokenizeShell(`echo 'a b'`), ['echo', 'a b']);
    assert.deepStrictEqual(tokenizeShell('echo a\\ b'), ['echo', 'a b']);
    assert.deepStrictEqual(tokenizeShell('   '), []);
  });
});

describe('审批缓存 CachedApproval（M4）', () => {
  it('二次相同请求命中缓存，不再问内层', async () => {
    const inner = new CountingApproval();
    const cache = new CachedApproval(inner);
    assert.strictEqual(await cache.decide(shellRequest('ls -la')), 'allow');
    assert.strictEqual(await cache.decide(shellRequest('ls -la')), 'allow');
    assert.strictEqual(inner.calls, 1);
    assert.strictEqual(cache.hits, 1);
    assert.strictEqual(cache.misses, 1);
  });

  it('规范化使不同包装命中同一缓存（审批键不再因 -lc/-c 差异 miss）', async () => {
    const inner = new CountingApproval();
    const cache = new CachedApproval(inner);
    await cache.decide(shellRequest('bash -lc "ls -la"'));
    await cache.decide(shellRequest('/bin/bash -c "ls -la"'));
    assert.strictEqual(inner.calls, 1, '包装不同但语义相同应命中同一缓存');
  });

  it('不同命令各自入键，互不影响', async () => {
    const inner = new CountingApproval();
    const cache = new CachedApproval(inner);
    await cache.decide(shellRequest('ls'));
    await cache.decide(shellRequest('rm -rf /'));
    assert.strictEqual(inner.calls, 2);
    assert.strictEqual(cache.size, 2);
  });

  it('非 shell 工具按原始 target 入键（不做命令规范化）', async () => {
    const inner = new CountingApproval();
    const cache = new CachedApproval(inner);
    await cache.decide(fileRequest('a/b.txt'));
    await cache.decide(fileRequest('a/b.txt'));
    await cache.decide(fileRequest('a/c.txt'));
    assert.strictEqual(inner.calls, 2);
  });

  it('策略指纹变化即失效', async () => {
    const inner = new CountingApproval();
    const stable = new CachedApproval(inner, { policyFingerprint: 'auto|passthrough' });
    const rotated = new CachedApproval(inner, { policyFingerprint: 'auto|restricted' });
    await stable.decide(shellRequest('ls'));
    await stable.decide(shellRequest('ls'));
    assert.strictEqual(inner.calls, 1);
    await rotated.decide(shellRequest('ls'));
    assert.strictEqual(inner.calls, 2, '策略变化不得沿用旧裁决');
  });

  it('cwd 变化即失效', async () => {
    const inner = new CountingApproval();
    const here = new CachedApproval(inner, { cwd: '/a' });
    const there = new CachedApproval(inner, { cwd: '/b' });
    await here.decide(shellRequest('ls'));
    await there.decide(shellRequest('ls'));
    assert.strictEqual(inner.calls, 2);
  });

  it('cacheDeny=false 时只缓存 allow', async () => {
    const inner = new CountingApproval('deny');
    const cache = new CachedApproval(inner, { cacheDeny: false });
    assert.strictEqual(await cache.decide(shellRequest('ls')), 'deny');
    assert.strictEqual(await cache.decide(shellRequest('ls')), 'deny');
    assert.strictEqual(inner.calls, 2, 'deny 不缓存，每次重新问');
    assert.strictEqual(cache.size, 0);
  });

  it('LRU 淘汰：超出上限淘汰最久未用条目', async () => {
    const inner = new CountingApproval();
    const cache = new CachedApproval(inner, { maxEntries: 2 });
    await cache.decide(shellRequest('a'));
    await cache.decide(shellRequest('b'));
    await cache.decide(shellRequest('a'));
    await cache.decide(shellRequest('c'));
    assert.strictEqual(cache.size, 2);
    await cache.decide(shellRequest('b'));
    assert.strictEqual(inner.calls, 4, 'b 已被淘汰，应重新问');
  });

  it('invalidate 清空缓存', async () => {
    const inner = new CountingApproval();
    const cache = new CachedApproval(inner);
    await cache.decide(shellRequest('ls'));
    cache.invalidate();
    assert.strictEqual(cache.size, 0);
    await cache.decide(shellRequest('ls'));
    assert.strictEqual(inner.calls, 2);
  });

  it('delegate 暴露被装饰的审批端口', () => {
    const inner = new CountingApproval();
    assert.strictEqual(new CachedApproval(inner).delegate.name, 'counting');
  });
});
