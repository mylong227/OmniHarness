import { test } from 'vitest';
import assert from 'node:assert/strict';
import { BrowserActTool } from '../../src/adapters/tool/browser/browserActTool.ts';
import { ReviewDiffTool } from '../../src/adapters/tool/verify/reviewDiffTool.ts';
import { WebSearchProviders } from '../../src/adapters/tool/web/webSearchProviders.ts';
import { MUTATING_TOOL_NAMES, TOOL_NAMES } from '../../src/ports/tool/toolNames.ts';
import type {
  BrowserActionPort,
  BrowserActionRequest,
} from '../../src/ports/tool/browserAction.ts';
import type { ModelOutput, ModelPort } from '../../src/ports/model/model.ts';

test('ACT-01：browser_act 进入写类工具集（plan/RBAC 会拦）', () => {
  assert.strictEqual(MUTATING_TOOL_NAMES.has(TOOL_NAMES.browserAct), true);
});

test('ACT-01：browser_act 把参数映射为动作请求并返回可读结果', async () => {
  const seen: BrowserActionRequest[] = [];
  const fake: BrowserActionPort = {
    act: async (request) => {
      seen.push(request);
      return { ok: true, output: '已点击 #submit' };
    },
  };
  const tool = new BrowserActTool({ session: fake });
  const result = await tool.handle(
    { id: 'c1', name: TOOL_NAMES.browserAct, arguments: { action: 'click', selector: '#submit' } },
    { sessionId: 's', workspaceRoot: '/tmp' },
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(seen[0]?.kind, 'click');
  assert.strictEqual(seen[0]?.selector, '#submit');
  assert.match(result.output ?? '', /已点击/);
});

test('ACT-01：browser_act 拒绝未知动作（fail-closed）', async () => {
  const tool = new BrowserActTool({ session: { act: async () => ({ ok: true, output: '' }) } });
  const result = await tool.handle(
    { id: 'c2', name: TOOL_NAMES.browserAct, arguments: { action: 'eval' } },
    { sessionId: 's', workspaceRoot: '/tmp' },
  );
  assert.strictEqual(result.ok, false);
  assert.match(result.error ?? '', /未知/);
});

test('ACT-02：无搜索 key 时不构造 provider；有 key 时构造', () => {
  assert.strictEqual(WebSearchProviders.fromEnv({}), undefined);
  const tool = WebSearchProviders.fromEnv({ BRAVE_API_KEY: 'x' });
  assert.ok(tool !== undefined);
});

test('VER-01：review_diff 只接收 diff/目标/测试，不读父历史', async () => {
  const requests: unknown[] = [];
  const model: ModelPort = {
    name: 'reviewer',
    generate: async (request): Promise<ModelOutput> => {
      requests.push(request);
      return {
        text: JSON.stringify([
          { severity: 'major', file: 'src/a.ts', line: 3, issue: '边界漏判', evidence: '空数组' },
        ]),
      };
    },
  };
  const tool = new ReviewDiffTool(model);
  const result = await tool.handle(
    {
      id: 'r1',
      name: TOOL_NAMES.reviewDiff,
      arguments: { diff: '--- a/src/a.ts\n+++ b/src/a.ts', goal: '修边界' },
    },
    { sessionId: 's', workspaceRoot: '/tmp' },
  );
  assert.strictEqual(result.ok, true);
  assert.match(result.output ?? '', /major/);
  assert.match(result.output ?? '', /src\/a\.ts:3/);
  const request = requests[0] as { messages: readonly { role: string; content: string }[] };
  assert.strictEqual(request.messages.length, 2);
  assert.strictEqual(request.messages[0]?.role, 'system');
  assert.ok(!request.messages.some((message) => message.content.includes('父会话历史')));
});
