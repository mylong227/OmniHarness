import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ModelRouter } from '../../src/adapters/model/modelRouter.ts';
import type { ModelPort } from '../../src/ports/model/model.ts';

const small: ModelPort = { name: 'small', generate: async () => ({ text: 'small' }) };
const large: ModelPort = { name: 'large', generate: async () => ({ text: 'large' }) };

test('OBS-02：by-context 排除装不下的模型，选能装下的最小窗口', async () => {
  const router = new ModelRouter({
    strategy: 'by-context',
    entries: [
      { adapter: small, model: 'small', maxContextTokens: 1000 },
      { adapter: large, model: 'large', maxContextTokens: 100_000 },
    ],
  });
  const output = await router.generate({
    messages: [{ role: 'user', content: 'x'.repeat(20_000) }],
    tools: [],
  });
  assert.strictEqual(output.text, 'large');
  assert.match(router.routeReason, /chosen=large/);
});

test('OBS-02：都装不下时回退全部候选（不静默失败）', async () => {
  const router = new ModelRouter({
    strategy: 'by-context',
    entries: [{ adapter: small, model: 'small', maxContextTokens: 10 }],
  });
  const output = await router.generate({
    messages: [{ role: 'user', content: 'x'.repeat(100) }],
    tools: [],
  });
  assert.strictEqual(output.text, 'small');
});
