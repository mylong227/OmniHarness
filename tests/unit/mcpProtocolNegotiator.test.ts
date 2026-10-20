import { test } from 'vitest';
import assert from 'node:assert/strict';
import { McpProtocolNegotiator } from '../../src/mcp/mcpProtocolNegotiator.ts';

test('INT-01：默认 auto 探测，显式值走对应栈', () => {
  assert.strictEqual(McpProtocolNegotiator.select({}), 'auto');
  assert.strictEqual(McpProtocolNegotiator.select({ OMNI_MCP_PROTOCOL: '' }), 'auto');
  assert.strictEqual(McpProtocolNegotiator.select({ OMNI_MCP_PROTOCOL: 'auto' }), 'auto');
  assert.strictEqual(
    McpProtocolNegotiator.select({ OMNI_MCP_PROTOCOL: '2026-07-28' }),
    'stateless-v2',
  );
  assert.strictEqual(McpProtocolNegotiator.select({ OMNI_MCP_PROTOCOL: 'legacy' }), 'legacy');
});

test('INT-01：支持两版协议版本', () => {
  assert.strictEqual(McpProtocolNegotiator.supports('2025-06-18'), true);
  assert.strictEqual(McpProtocolNegotiator.supports('2026-07-28'), true);
  assert.strictEqual(McpProtocolNegotiator.supports('1999-01-01'), false);
});
