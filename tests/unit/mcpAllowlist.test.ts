import { test } from 'vitest';
import assert from 'node:assert/strict';
import { McpConnector } from '../../src/mcp/mcpConnector.ts';

test('SEC-04：MCP 白名单未设置时放行，设置后只放行登记 server', () => {
  assert.strictEqual(McpConnector.isAllowed('a', {}), true);
  assert.strictEqual(McpConnector.isAllowed('a', { OMNI_MCP_ALLOW: 'a,b' }), true);
  assert.strictEqual(McpConnector.isAllowed('c', { OMNI_MCP_ALLOW: 'a,b' }), false);
});
