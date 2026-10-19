// 工作区网页预览源的判据（2026-10-19）。
//
// 覆盖的是**特性成立的最小面**，每条都能改坏它：
//   ① 根路径 / 目录路径回落到 index.html（静态站点"打开文件夹就能看"）；
//   ② 相对资源按扩展名给对的 MIME（HTML/CSS/JS/字体；否则浏览器把样式与模块当二进制）；
//   ③ 只读：POST 405；HEAD 只回头；未知路径 404；
//   ④ 越界 fail-closed：`%5c..%5c` 编码的反斜杠段也必须 403（不能靠 URL 规范化放行）；
//   ⑤ 响应头：no-store + nosniff，且**没有** Content-Disposition（有它浏览器会下载而不是渲染）；
//   ⑥ 关闭幂等。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PreviewServer } from '../../src/server/transport/previewServer.ts';

/** 造一个临时站点：根 index.html + 子目录站点 + 各种资源。 */
function makeSite(): string {
  const root = mkdtempSync(join(tmpdir(), 'omni-preview-'));
  writeFileSync(join(root, 'index.html'), '<h1>首页</h1>', 'utf8');
  writeFileSync(join(root, 'app.js'), 'console.log(1)', 'utf8');
  writeFileSync(join(root, 'app.css'), 'h1{color:red}', 'utf8');
  writeFileSync(join(root, 'font.woff2'), Buffer.from([0, 1, 2, 3]));
  writeFileSync(join(root, 'data.bin'), Buffer.from([0, 1, 2]));
  writeFileSync(join(root, '.env'), 'SECRET=1', 'utf8');
  mkdirSync(join(root, '.well-known'));
  writeFileSync(join(root, '.well-known', 'probe.txt'), 'ok', 'utf8');
  mkdirSync(join(root, 'site'));
  writeFileSync(join(root, 'site', 'index.html'), '<h1>子站</h1>', 'utf8');
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'index.htm'), '<h1>htm 索引</h1>', 'utf8');
  return root;
}

/**
 * 起一个预览源并返回基地址。
 * @param root 工作区根
 * @returns 服务实例与 base URL
 */
async function start(root: string): Promise<{ server: PreviewServer; base: string }> {
  const server = new PreviewServer({ workspaceRoot: () => root });
  const port = await server.start(0);
  return { server, base: `http://127.0.0.1:${String(port)}` };
}

test('预览源：根路径 / 目录路径回落 index.html（html + htm 两种）', async () => {
  const root = makeSite();
  const { server, base } = await start(root);
  try {
    for (const [path, expected] of [
      ['/', '首页'],
      ['/site/', '子站'],
      ['/site', '子站'],
      ['/docs/', 'htm 索引'],
    ] as const) {
      const response = await fetch(base + path);
      assert.strictEqual(response.status, 200, `${path} 应命中索引`);
      assert.match(await response.text(), new RegExp(expected), `${path} 的内容`);
    }
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('预览源：相对资源按扩展名给 MIME（CSS/JS/字体/未知二进制）', async () => {
  const root = makeSite();
  const { server, base } = await start(root);
  try {
    const cases: readonly [string, string][] = [
      ['/app.css', 'text/css; charset=utf-8'],
      ['/app.js', 'text/javascript; charset=utf-8'],
      ['/font.woff2', 'font/woff2'],
      ['/data.bin', 'application/octet-stream'],
    ];
    for (const [path, expected] of cases) {
      const response = await fetch(base + path);
      assert.strictEqual(response.status, 200, path);
      assert.strictEqual(response.headers.get('content-type'), expected, path + ' 的 MIME');
    }
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('预览源：HTML 响应头 no-store + nosniff，且不得带 Content-Disposition（否则是下载）', async () => {
  const root = makeSite();
  const { server, base } = await start(root);
  try {
    const response = await fetch(`${base}/index.html`);
    assert.strictEqual(response.status, 200);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/u);
    assert.strictEqual(response.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(
      response.headers.get('content-disposition'),
      null,
      '预览必须内联渲染；Content-Disposition 会让浏览器改为下载',
    );
    assert.match(response.headers.get('content-type') ?? '', /^text\/html;\s*charset=utf-8$/u);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('预览源：只读（POST 405 / HEAD 无正文 / 缺失 404）', async () => {
  const root = makeSite();
  const { server, base } = await start(root);
  try {
    const post = await fetch(`${base}/index.html`, { method: 'POST' });
    assert.strictEqual(post.status, 405, '预览源不接受写方法');
    assert.match(post.headers.get('allow') ?? '', /GET/u);
    const head = await fetch(`${base}/index.html`, { method: 'HEAD' });
    assert.strictEqual(head.status, 200);
    assert.strictEqual(await head.text(), '', 'HEAD 不得返回正文');
    const missing = await fetch(`${base}/nope.html`);
    assert.strictEqual(missing.status, 404);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('预览源：编码反斜杠的越界路径必须 403（fail-closed，不靠 URL 规范化兜底）', async () => {
  const outer = mkdtempSync(join(tmpdir(), 'omni-preview-outer-'));
  const root = join(outer, 'ws');
  mkdirSync(root);
  writeFileSync(join(outer, 'secret.txt'), 'TOP SECRET', 'utf8');
  writeFileSync(join(root, 'index.html'), '<h1>ok</h1>', 'utf8');
  const { server, base } = await start(root);
  try {
    // `%5c` 在 URL 里不会被当成分隔符规范化，解码后是 Windows 分隔符；本地预览必须把它
    // 按分隔符处理后再做越界判定（否则 Windows 上会读到工作区外）。
    const response = await fetch(`${base}/%5c..%5csecret.txt`);
    assert.strictEqual(response.status, 403, '越界路径必须是 403，而不是把工作区外文件读出去');
    assert.doesNotMatch(await response.text(), /TOP SECRET/u);
  } finally {
    await server.close();
    rmSync(outer, { recursive: true, force: true });
  }
});

test('预览源：点文件默认拒绝，`.well-known` 例外（sirv 默认口径）', async () => {
  const root = makeSite();
  const { server, base } = await start(root);
  try {
    const secret = await fetch(`${base}/.env`);
    assert.strictEqual(secret.status, 404, '点文件不得经预览源暴露');
    const wellKnown = await fetch(`${base}/.well-known/probe.txt`);
    assert.strictEqual(wellKnown.status, 200, '.well-known 是规范允许的例外');
    assert.strictEqual(await wellKnown.text(), 'ok');
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('预览源：工作区未配置 → 503；close 幂等', async () => {
  const server = new PreviewServer({ workspaceRoot: () => '' });
  const port = await server.start(0);
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/`);
    assert.strictEqual(response.status, 503);
  } finally {
    await server.close();
    await server.close();
  }
  assert.strictEqual(server.port, 0, '关闭后端口应归零');
});
