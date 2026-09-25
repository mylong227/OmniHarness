import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SsrfGuard } from '../../src/security/ssrfGuard.js';

describe('SSRF 防护', () => {
  it('云元数据地址一律拦截（默认策略下也不放行）', async () => {
    const verdict = SsrfGuard.inspectHost('169.254.169.254', SsrfGuard.defaultSsrfOptions());
    assert.strictEqual(verdict.blocked, true);
    await assert.rejects(
      () =>
        SsrfGuard.assertNotSsrf(
          'http://169.254.169.254/latest/meta-data/',
          SsrfGuard.defaultSsrfOptions(),
        ),
      /SSRF 拦截/,
    );
  });

  it('各厂商元数据主机名被拦截', () => {
    for (const host of ['metadata.google.internal', '100.100.100.200']) {
      const verdict = SsrfGuard.inspectHost(host, { allowPrivate: true });
      assert.strictEqual(verdict.blocked, true, `${host} 应被拦截`);
    }
  });

  it('默认策略放行私有网段（本地 Ollama / 出厂 A2A 端点是合法场景）', () => {
    for (const host of ['127.0.0.1', '10.0.0.5', '192.168.1.10', '172.16.0.1']) {
      const verdict = SsrfGuard.inspectHost(host, SsrfGuard.defaultSsrfOptions());
      assert.strictEqual(verdict.blocked, false, `${host} 默认应放行`);
    }
  });

  it('严格模式（allowPrivate 未开启）拦截私有网段', () => {
    for (const host of ['127.0.0.1', '10.0.0.5', '192.168.1.10', '169.254.1.1']) {
      const verdict = SsrfGuard.inspectHost(host, {});
      assert.strictEqual(verdict.blocked, true, `${host} 在严格模式下应拦截`);
    }
  });

  it('OMNI_SSRF_STRICT=1 时默认策略转为严格', () => {
    const saved = process.env['OMNI_SSRF_STRICT'];
    process.env['OMNI_SSRF_STRICT'] = '1';
    try {
      assert.strictEqual(SsrfGuard.defaultSsrfOptions().allowPrivate, false);
    } finally {
      if (saved === undefined) {
        delete process.env['OMNI_SSRF_STRICT'];
      } else {
        process.env['OMNI_SSRF_STRICT'] = saved;
      }
    }
  });

  it('本机/内网域名后缀被拦截', () => {
    for (const host of ['localhost', 'db.local', 'svc.internal', 'nas.lan']) {
      const verdict = SsrfGuard.inspectHost(host, {});
      assert.strictEqual(verdict.blocked, true, `${host} 应被拦截`);
    }
  });

  it('IPv6 环回与唯一本地地址被拦截', () => {
    for (const host of ['::1', 'fd00::1', 'fe80::1']) {
      const verdict = SsrfGuard.inspectHost(host, {});
      assert.strictEqual(verdict.blocked, true, `${host} 应被拦截`);
    }
  });

  it('IPv4-mapped IPv6 按 IPv4 规则判定（::ffff:127.0.0.1 应拦截）', () => {
    assert.strictEqual(SsrfGuard.inspectHost('::ffff:127.0.0.1', {}).blocked, true);
  });

  it('公网地址放行', () => {
    for (const host of ['93.184.216.34', '8.8.8.8']) {
      assert.strictEqual(SsrfGuard.inspectHost(host, {}).blocked, false, `${host} 应放行`);
    }
  });

  it('inspectUrl 拦截非 HTTP(S) 协议与非法 URL（fail-closed）', () => {
    assert.strictEqual(SsrfGuard.inspectUrl('file:///etc/passwd').blocked, true);
    assert.strictEqual(SsrfGuard.inspectUrl('gopher://127.0.0.1:6379/_INFO').blocked, true);
    assert.strictEqual(SsrfGuard.inspectUrl('不是URL').blocked, true);
    assert.strictEqual(SsrfGuard.inspectUrl('').blocked, true);
  });

  it('inspectUrl 同步判定正常工作，可用于发送前快速拦截', () => {
    assert.strictEqual(SsrfGuard.inspectUrl('https://api.example.com/v1', {}).blocked, false);
    assert.strictEqual(SsrfGuard.inspectUrl('http://169.254.169.254/', {}).blocked, true);
  });

  it('非法 IPv4 字面量按拦截处理（宁可拒绝也不放行）', () => {
    assert.strictEqual(SsrfGuard.inspectHost('999.1.1.1', {}).blocked, true);
    assert.strictEqual(SsrfGuard.inspectHost('1.2.3', {}).blocked, true);
  });

  it('放行私有但拒绝元数据：allowPrivate 与 allowMetadata 互不覆盖', () => {
    const opts = { allowPrivate: true, allowMetadata: false };
    assert.strictEqual(SsrfGuard.inspectHost('10.0.0.1', opts).blocked, false);
    assert.strictEqual(SsrfGuard.inspectHost('169.254.169.254', opts).blocked, true);
  });
});

// ---- 双向单测：合法目标必须放行（不被过度收紧）+ 非法/危险目标必须拒绝 ----
describe('SSRF 双向单测（合法不收紧 / 非法必拒）', () => {
  it('方向一：合法目标必须放行——不被过度收紧（默认策略放行私有网段）', () => {
    const def = SsrfGuard.defaultSsrfOptions();
    // 完整 URL 用 inspectUrl；裸主机/域名用 inspectHost。
    assert.strictEqual(
      SsrfGuard.inspectUrl('https://api.example.com/v1', def).blocked,
      false,
      '公网 https 应放行',
    );
    assert.strictEqual(
      SsrfGuard.inspectUrl('http://127.0.0.1:8790/a2a', def).blocked,
      false,
      '出厂 A2A 端点（loopback）默认应放行',
    );
    assert.strictEqual(
      SsrfGuard.inspectUrl('http://93.184.216.34/', def).blocked,
      false,
      '公网 IPv4（带 scheme）应放行',
    );
    assert.strictEqual(SsrfGuard.inspectHost('example.org', def).blocked, false, '普通域名应放行');
  });

  it('方向二：非法/危险目标必须拒绝（严格模式 + fail-closed）', async () => {
    const strict = {}; // allowPrivate 未开 → 私有/loopback 一律拦截
    const illegalHosts = [
      '169.254.169.254',
      'metadata.google.internal',
      'localhost',
      'db.internal',
      '::1',
      'fd00::1',
      '999.1.1.1',
    ];
    for (const h of illegalHosts) {
      assert.strictEqual(SsrfGuard.inspectHost(h, strict).blocked, true, `${h} 必须被拒`);
    }
    await assert.rejects(() => SsrfGuard.assertNotSsrf('file:///etc/passwd', strict), /SSRF 拦截/);
    await assert.rejects(
      () => SsrfGuard.assertNotSsrf('gopher://127.0.0.1:6379/x', strict),
      /SSRF 拦截/,
    );
    await assert.rejects(() => SsrfGuard.assertNotSsrf('不是URL', strict), /SSRF 拦截/);
  });

  it('严格模式：allowPrivate=false 时私有网段被拒，元数据仍被拒（互不覆盖）', () => {
    const strict = { allowPrivate: false };
    assert.strictEqual(SsrfGuard.inspectHost('127.0.0.1', strict).blocked, true);
    // 即便显式 allowMetadata=true，元数据地址也永远拦截
    assert.strictEqual(
      SsrfGuard.inspectHost('169.254.169.254', { ...strict, allowMetadata: true }).blocked,
      true,
    );
  });
});

// ---- 2026-09-22 回归：IPv6 内嵌 IPv4 的写法曾绕过全部判定（实测复现后修复）----
describe('SSRF 回归：IPv6 内嵌 IPv4 的等价写法不得绕过', () => {
  it('元数据地址的点分 / 十六进制 / 全零展开写法一律拦截（默认策略下）', () => {
    const def = SsrfGuard.defaultSsrfOptions();
    for (const host of [
      '[::ffff:169.254.169.254]',
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe',
      '0:0:0:0:0:ffff:a9fe:a9fe',
    ]) {
      assert.strictEqual(
        SsrfGuard.inspectHost(host, def).blocked,
        true,
        `${host} 应被判为云元数据`,
      );
    }
    assert.strictEqual(
      SsrfGuard.inspectUrl('http://[::ffff:169.254.169.254]/latest/meta-data/', def).blocked,
      true,
      'URL 形态同样必须拦住',
    );
  });

  it('严格模式：mapped / compatible / NAT64 / 6to4 形式的环回与私有地址一律拦截', () => {
    const strict = {};
    for (const host of [
      '::ffff:7f00:1', // mapped 十六进制 → 127.0.0.1
      '::ffff:10.0.0.5', // mapped 点分 → 10.0.0.5
      '::7f00:1', // IPv4-compatible → 127.0.0.1
      '64:ff9b::7f00:1', // NAT64 → 127.0.0.1
      '2002:7f00:0001::', // 6to4 → 127.0.0.1
    ]) {
      assert.strictEqual(
        SsrfGuard.inspectHost(host, strict).blocked,
        true,
        `${host} 严格模式应拦截`,
      );
    }
  });

  it('公网地址不被过度收紧（mapped 与原生 IPv6 均放行）', () => {
    assert.strictEqual(SsrfGuard.inspectHost('::ffff:8.8.8.8', {}).blocked, false);
    assert.strictEqual(SsrfGuard.inspectHost('2001:4860:4860::8888', {}).blocked, false);
  });
});
