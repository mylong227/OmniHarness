/**
 * CLI **本地子命令**判据（2026-10-11，(9)「CLI 子命令启动」那轮的配套覆盖）。
 *
 * ## 为什么补这一条
 *
 * 把 `cliServerCmds` / `cliMcpCmds` 的重依赖改成方法内动态 import 后，覆盖率门禁报这两个文件
 * 低于冻结基线（`cliServerCmds` 47.98% → 43.39%、`cliMcpCmds` 37.5% → 32.28%）。
 * 根因不是测试变少，而是**此前相当一部分覆盖来自子进程"顺带加载"**：任何 CLI 子进程都会把整条
 * 继承链的模块拉起来，于是这些文件被"路过"标记为已执行。懒加载消除了这种副作用加载 —— 这正是
 * 修复的目的，但也暴露出**真实的**覆盖缺口：这些文件里的本地子命令此前**没有被判据真跑过**。
 *
 * 处置按本仓惯例：**补判据，而不是下调基线**。这里跑的都是**本地、零外部依赖、无副作用**的命令，
 * 顺带把它们的对外行为钉死（退出码与可读原因）。
 *
 * ## 判据口径
 *
 * | # | 判据 | 坏掉的后果 |
 * | --- | --- | --- |
 * | ① | `doctor` 打印诊断报告并 exit 0 | 诊断是排障入口，静默失败等于没有 |
 * | ② | `schema` 打印协议文档并 exit 0 | SDK/协议面 |
 * | ③ | `identity show` 无密钥 ⇒ **exit 1 + 可读原因**（fail-closed，不假装成功） | 没有身份却看起来能用 |
 * | ④ | `identity generate` → `show --private-key` + `sign`/`verify` **往返成功** | 密钥格式漂移会静默破坏签名 |
 * | ⑤ | `daemon status` 恒 exit 0 且如实说运行/未运行 | 面板与 CLI 口径分叉 |
 * | ⑥ | `mcp list` 缺 `--server` ⇒ **用法 + exit 2**（误用不得静默） | 误用被当成"空列表" |
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/** 仓库根。 */
const REPO_ROOT = process.cwd();
/** CLI 入口。 */
const CLI = join(REPO_ROOT, 'dist/src/cli/exec.js');

/**
 * 跑一次 CLI。
 * @param args 子命令与参数
 * @returns 退出码与合并输出
 */
function runCli(args: readonly string[]): { code: number; out: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, OMNI_REPO_MAP: '0' },
  });
  return { code: result.status ?? 1, out: `${result.stdout}\n${result.stderr}` };
}

test('① doctor：打印诊断报告并 exit 0', () => {
  const { code, out } = runCli(['doctor']);
  assert.strictEqual(code, 0, `doctor 应正常退出：\n${out}`);
  assert.match(out, /OmniHarness 诊断报告/u, '必须打印报告标题');
  assert.match(out, /Node/u, '报告应含 Node 版本一行');
});

test('② schema：打印协议文档并 exit 0', () => {
  const { code, out } = runCli(['schema']);
  assert.strictEqual(code, 0, `schema 应正常退出：\n${out}`);
  assert.match(out, /OmniHarness 协议文档/u, '必须打印协议文档标题');
});

test('③ identity show 无密钥 ⇒ exit 1 + 可读原因（fail-closed）', () => {
  const { code, out } = runCli(['identity', 'show']);
  assert.strictEqual(code, 1, `缺身份时必须失败：\n${out}`);
  assert.match(out, /identity 未配置/u, '必须给出可读原因');
  assert.match(out, /--private-key/u, '必须给出修复路径（怎么配）');
});

test('④ identity generate → show/sign/verify 往返成功', () => {
  const generated = runCli(['identity', 'generate']);
  assert.strictEqual(generated.code, 0, `generate 应成功：\n${generated.out}`);
  const match = /\{"privateKeyPkcs8Base64":"([^"]+)"/u.exec(generated.out);
  assert.ok(match !== null, `generate 必须输出 PKCS8 私钥：\n${generated.out}`);
  const key = match[1] ?? '';

  const shown = runCli(['identity', 'show', '--private-key', key]);
  assert.strictEqual(shown.code, 0, `show 应接受自己生成的密钥：\n${shown.out}`);

  const signed = runCli(['identity', 'sign', '--private-key', key, '--payload', 'ping']);
  assert.strictEqual(signed.code, 0, `sign 应成功：\n${signed.out}`);
  // 字段名是 `signature`（不是 `signatureBase64`）——首版按猜的名字断言，白红了一次。
  const sig = /"signature":"([^"]+)"/u.exec(signed.out)?.[1] ?? '';
  assert.notStrictEqual(sig, '', `sign 必须输出签名：\n${signed.out}`);

  const verified = runCli([
    'identity',
    'verify',
    '--private-key',
    key,
    '--payload',
    'ping',
    '--signature',
    sig,
  ]);
  assert.strictEqual(verified.code, 0, `verify 应通过：\n${verified.out}`);

  // **反面对照**：换一个 payload 必须验不过（否则"验通过"可能只是恒真）。
  const tampered = runCli([
    'identity',
    'verify',
    '--private-key',
    key,
    '--payload',
    'pong',
    '--signature',
    sig,
  ]);
  assert.notStrictEqual(tampered.code, 0, '改了 payload 仍验通过 ⇒ 签名校验没有牙');
});

test('⑤ daemon status：exit 0 且如实报运行态', () => {
  const { code, out } = runCli(['daemon', 'status']);
  assert.strictEqual(code, 0, `daemon status 应恒 exit 0（未运行是合法状态）：\n${out}`);
  assert.match(out, /daemon (未运行|运行中)/u, '必须如实报运行态');
});

test('⑥ mcp list 缺 --server ⇒ 用法 + exit 2（误用不得静默）', () => {
  const { code, out } = runCli(['mcp', 'list']);
  assert.strictEqual(code, 2, `误用应回用法码 2：\n${out}`);
  assert.match(out, /用法: omniharness mcp list/u, '必须打印用法');
});
