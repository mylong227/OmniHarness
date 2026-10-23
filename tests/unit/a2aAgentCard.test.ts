/**
 * A2A AgentCard well-known 路由判据。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { HttpA2aServerTransport } from '../../src/a2a/httpA2aTransport.ts';

test('GET /.well-known/agent-card.json 返回已设置的 AgentCard；未设置 404', async () => {
  const transport = new HttpA2aServerTransport();
  const port = await transport.listen(0);
  try {
    const missing = await fetch(`http://127.0.0.1:${String(port)}/.well-known/agent-card.json`);
    assert.strictEqual(missing.status, 404);

    transport.setAgentCard({
      name: 'omniharness',
      description: 'test',
      version: '0.2.0',
      skills: [{ id: 's', name: 's' }],
    });
    const response = await fetch(`http://127.0.0.1:${String(port)}/.well-known/agent-card.json`);
    assert.strictEqual(response.status, 200);
    const card = (await response.json()) as { name?: string; skills?: unknown[] };
    assert.strictEqual(card.name, 'omniharness');
    assert.strictEqual(card.skills?.length, 1);
  } finally {
    transport.close();
  }
});
