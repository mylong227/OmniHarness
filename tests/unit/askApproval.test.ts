import { test, describe } from 'vitest';
import assert from 'node:assert/strict';
import { AskApproval } from '../../src/adapters/approval/askApproval.ts';
import { TOOL_NAMES } from '../../src/ports/tool/toolNames.ts';

/** 请求批准档：本地只读自动放行，其余一律询问（无回调时 fail-closed 拒绝）。 */
describe('AskApproval', () => {
  test('标识为 ask', () => {
    assert.strictEqual(new AskApproval().name, 'ask');
  });

  test('本地只读工具自动放行（不询问）', async () => {
    const port = new AskApproval();
    for (const tool of [
      TOOL_NAMES.readFile,
      TOOL_NAMES.listDir,
      TOOL_NAMES.grep,
      TOOL_NAMES.glob,
      TOOL_NAMES.memorySearch,
      TOOL_NAMES.recall,
      TOOL_NAMES.todoRead,
      TOOL_NAMES.viewImage,
    ]) {
      assert.strictEqual(
        await port.decide({ sessionId: 's', toolName: tool, target: 'x' }),
        'allow',
        `${tool} 是本地只读，应自动放行`,
      );
    }
  });

  test('编辑 / 命令 / 联网一律询问（回调裁决生效）', async () => {
    const answers: string[] = [];
    const port = new AskApproval({
      askHandler: async (request) => {
        answers.push(request.toolName);
        return 'allow';
      },
    });
    for (const tool of [
      TOOL_NAMES.writeFile,
      TOOL_NAMES.edit,
      TOOL_NAMES.shell,
      TOOL_NAMES.webSearch,
      TOOL_NAMES.webFetch,
      TOOL_NAMES.browserScreenshot,
    ]) {
      assert.strictEqual(
        await port.decide({ sessionId: 's', toolName: tool, target: 'x' }),
        'allow',
        `${tool} 非本地只读，应经询问回调`,
      );
    }
    assert.deepEqual(answers.sort(), [
      TOOL_NAMES.browserScreenshot,
      TOOL_NAMES.edit,
      TOOL_NAMES.shell,
      TOOL_NAMES.webFetch,
      TOOL_NAMES.webSearch,
      TOOL_NAMES.writeFile,
    ]);
  });

  test('未提供回调时非白名单一律 deny（fail-closed：问不到人 ≠ 放行）', async () => {
    const port = new AskApproval();
    assert.strictEqual(
      await port.decide({ sessionId: 's', toolName: TOOL_NAMES.shell, target: 'ls' }),
      'deny',
    );
    assert.strictEqual(
      await port.decide({ sessionId: 's', toolName: TOOL_NAMES.webSearch, target: 'q' }),
      'deny',
    );
  });

  test('白名单与 plan 档的差异恰好是联网两项（防两表漂移）', async () => {
    // 请求批准档的「使用互联网时始终询问」落点：web_search / web_fetch 必须问，
    // 而计划模式把它们当只读放行——除此之外两张白名单必须完全一致。
    const { PLAN_ALLOWED_TOOLS } = await import('../../src/adapters/approval/planApproval.ts');
    const asked: string[] = [];
    const ask = new AskApproval({
      askHandler: async (request) => {
        asked.push(request.toolName);
        return 'allow';
      },
    });
    for (const tool of PLAN_ALLOWED_TOOLS) {
      const verdict = await ask.decide({ sessionId: 's', toolName: tool, target: 'x' });
      const isNetwork = tool === TOOL_NAMES.webSearch || tool === TOOL_NAMES.webFetch;
      if (isNetwork) {
        assert.ok(asked.includes(tool), `${tool} 联网工具必须经询问回调`);
      } else {
        assert.strictEqual(verdict, 'allow');
        assert.ok(!asked.includes(tool), `${tool} 本地只读不应弹询问`);
      }
    }
  });
});
