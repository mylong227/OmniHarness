import { test } from 'vitest';
import assert from 'node:assert/strict';
import { GoalChecker } from '../../src/autonomy/goalChecker.ts';
import type { ModelOutput, ModelPort } from '../../src/ports/model/model.ts';

const neverCalled: ModelPort = {
  name: 'never',
  generate: async (): Promise<ModelOutput> => {
    throw new Error('不应调用模型');
  },
};

test('VER-03：机械证据不通过时不调用模型判定', async () => {
  const check = await new GoalChecker(neverCalled).check('目标', '进展', {
    mechanicallyVerified: false,
  });
  assert.strictEqual(check.achieved, false);
  assert.match(check.raw, /机械证据未通过/);
});

test('VER-03：证据会进入判定 prompt', async () => {
  let seen = '';
  const model: ModelPort = {
    name: 'judge',
    generate: async (request) => {
      seen = request.messages.map((message) => message.content).join('\n');
      return { text: 'YES 已完成' };
    },
  };
  const check = await new GoalChecker(model).check('目标', '进展', {
    mechanicallyVerified: true,
    evidence: 'shell、read_file',
  });
  assert.strictEqual(check.achieved, true);
  assert.match(seen, /shell、read_file/);
});
