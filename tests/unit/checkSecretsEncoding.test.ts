/**
 * `checkSecrets` 的**编码盲区**判据（2026-10-06 第五十七轮 ④ 收口）。
 *
 * ## 它锁的是什么
 *
 * 修复前的形态：门禁用 `git grep -I`，而 `-I` 会**跳过 git 判为二进制的文件**——**UTF-16LE 保存的
 * 文本文件含 NUL 字节，在 git 眼里就是二进制**；同时 ASCII 正则在其字节序列里永远匹配不到
 * （`s\0k\0-\0…`）。两条叠加 ⇒「把带密钥的配置存成 UTF-16」可**静默绕过**发布物零密钥门禁。
 *
 * | # | 判据 |
 * | --- | --- |
 * | ① | UTF-16LE + 疑似密钥（无豁免标记）⇒ **必须被拒**（修复前 exit 0） |
 * | ② | 同一内容加豁免标记 ⇒ 通过，且汇总行**如实报出"按编码解码 1"**（证明真解码了，不是碰巧） |
 * | ③ | 正对照：同样的密钥放 UTF-8 文本 ⇒ 被拒（判据不是"一律拒绝"） |
 * | ④ | 汇总行必须包含扫描面数字（"扫描范围塌缩"与"真的零密钥"在输出上可区分） |
 *
 * 判据用**临时 git 仓库**跑真门禁（`--staged` 走 index），而不是 import 脚本内部函数：
 * 该脚本是"跑一次就判定"的顶层过程，import 即执行，测不到真实路径。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts', 'checkSecrets.mjs');
/** 一个形似真实模型密钥的串（长度满足 sk- 规则）。 */
const FAKE_KEY = 'sk-abcdefghijklmnopqrstuvwx'; // omniharness:fake-secret
/** 豁免标记（与门禁同字面量）。 */
const ALLOW = 'omniharness:fake-secret';

/**
 * 造一个临时 git 仓库，把给定文件写进去并 `git add`。
 * @param files 文件名 → 内容（`utf16le` 时按 UTF-16LE 编码写入）。
 * @returns 临时仓库路径（调用方负责清理）。
 */
function makeRepo(
  files: readonly { readonly name: string; readonly text: string; readonly utf16le?: boolean }[],
): string {
  const dir = mkdtempSync(join(tmpdir(), 'omni-secrets-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] });
  for (const f of files) {
    const abs = join(dir, f.name);
    if (f.utf16le === true) {
      // UTF-16LE + BOM：与记事本/PowerShell `>` 重定向的产物同形。
      const buf = Buffer.from(`\ufeff${f.text}`, 'utf16le');
      writeFileSync(abs, buf);
    } else {
      writeFileSync(abs, f.text, 'utf8');
    }
  }
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] });
  return dir;
}

/**
 * 在给定仓库里跑门禁（`--staged`）。
 * @param cwd 仓库路径。
 * @returns 退出码与 stdout/stderr（进程崩了按 1 计）。
 */
function runGate(cwd: string): {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
} {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, '--staged'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

test('① UTF-16LE 文本里的疑似密钥必须被拒（修复前 git grep -I 会跳过该文件）', () => {
  const dir = makeRepo([{ name: 'cfg.txt', text: `key = ${FAKE_KEY}\n`, utf16le: true }]);
  try {
    const r = runGate(dir);
    assert.strictEqual(
      r.status,
      1,
      `必须非零退出，实际：${String(r.status)}\n${r.stdout}${r.stderr}`,
    );
    assert.match(r.stderr, /疑似真实密钥/, 'stderr 必须点明命中');
    assert.match(r.stderr, /解码命中/, '必须说明它是**解码后**命中的（编码层在工作）');
    assert.doesNotMatch(
      r.stderr,
      new RegExp(FAKE_KEY),
      '不得回显密钥内容（门禁自身不能成为泄露面）',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('② 带豁免标记的同一文件通过，且汇总行如实报出"按编码解码 1"', () => {
  const dir = makeRepo([
    { name: 'cfg.txt', text: `key = ${FAKE_KEY}  # ${ALLOW}\n`, utf16le: true },
  ]);
  try {
    const r = runGate(dir);
    assert.strictEqual(r.status, 0, `应通过，实际：${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /按编码解码 1/, '汇总行必须证明真解码了该文件（否则判据可能是碰巧绿）');
    assert.match(r.stdout, /二进制分类 1/, '汇总行必须报出二进制分类计数');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('③ 正对照：同样的密钥放 UTF-8 文本同样被拒（判据不是一律拒绝/一律放过）', () => {
  const dir = makeRepo([{ name: 'cfg.txt', text: `key = ${FAKE_KEY}\n` }]);
  try {
    const r = runGate(dir);
    assert.strictEqual(r.status, 1, `UTF-8 路径必须被拒：${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /疑似真实密钥/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('④ 无密钥仓库通过，且汇总行包含扫描面数字（范围塌缩可被发现）', () => {
  const dir = makeRepo([{ name: 'readme.txt', text: 'nothing to see here\n' }]);
  try {
    const r = runGate(dir);
    assert.strictEqual(r.status, 0, `应通过：${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /暂存文件 1/, '汇总行必须报出实际扫描的文件数');
    assert.match(r.stdout, /文本层范围/, '汇总行必须交代文本层扫了多大范围');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
