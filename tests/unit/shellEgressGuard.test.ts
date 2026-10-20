import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ShellCommandPolicy } from '../../src/adapters/tool/shell/shellCommandPolicy.ts';

test('SEC-02：网络白名单开启时 shell 带外通道被工具层拒绝', () => {
  const previous = process.env['OMNI_NETWORK_ALLOW'];
  process.env['OMNI_NETWORK_ALLOW'] = 'api.example.com';
  try {
    const policy = new ShellCommandPolicy({ mode: 'audit' });
    const denied = policy.decide('curl https://api.example.com');
    assert.match(denied ?? '', /带外网络通道/);
  } finally {
    if (previous === undefined) delete process.env['OMNI_NETWORK_ALLOW'];
    else process.env['OMNI_NETWORK_ALLOW'] = previous;
  }
});
