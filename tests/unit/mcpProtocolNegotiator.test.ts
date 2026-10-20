import { test } from 'vitest';
import assert from 'node:assert/strict';
import { McpProtocolNegotiator } from '../../src/mcp/mcpProtocolNegotiator.ts';

test('INT-01：默认走 legacy，显式 2026-07-28 走 stateless-v2', () => {
  assert.strictEqual(McpProtocolNegotiator.select({}), 'legacy');
  assert.strictEqual(
    McpProtocolNegotiator.select({ OMNI_MCP_PROTOCOL: '2026-07-28' }),
    'stateless-v2',
  );
});

test('INT-01：支持两版协议版本', () => {
  assert.strictEqual(McpProtocolNegotiator.supports('2025-06-18'), true);
  assert.strictEqual(McpProtocolNegotiator.supports('2026-07-28'), true);
  assert.strictEqual(McpProtocolNegotiator.supports('1999-01-01'), false);
});
