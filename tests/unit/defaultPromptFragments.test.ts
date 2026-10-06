/**
 * 系统提示必须声明**运行环境**（2026-10-06 第六十一轮真实模型复杂任务跑测暴露）。
 *
 * ## 它锁的是什么
 *
 * 用真模型在 **Windows** 上跑一件纯编码任务，模型开场连发
 * `pwd && ls -la && node --version && cat package.json`、再来 `ls -la src test`、
 * `node --test test/xxx | tail -n 12; echo "exit=${PIPESTATUS[0]}"` —— 全部被 `cmd.exe` 回
 * 「不是内部或外部命令」，**白烧 4 次工具调用**（实测事件流可查）才发现要用 cmd 方言。
 *
 * 根因不是模型笨，而是系统提示**从未告诉它自己在什么平台、shell 是哪一种**：训练语料默认 POSIX，
 * 而本机 `shell` 工具是 `cmd.exe /d /s /c`（`ShellInvocation`）。故本判据把「第四节·运行环境」
 * 钉住：平台名 + 真 shell + 该方言的禁用词，缺一即红。
 *
 * | # | 判据 |
 * | --- | --- |
 * | ① | `win32` 文案必须点明 `cmd.exe`、列出 POSIX 禁用词、给出 `%ERRORLEVEL%` 取退出码 |
 * | ② | POSIX 文案必须给 POSIX 工具与 `$?`，且**不得**出现 `cmd.exe`（防跨平台文案串味） |
 * | ③ | 两个平台的文案必须**不同**（防"加了参数却没接进正文"这种假接线） |
 * | ④ | 缺省参数必须取**当前进程**真实环境（平台与 `ShellInvocation.path()` 同源） |
 * | ⑤ | 仍返回**单片段**（前缀缓存契约：基础片段数不变） |
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultPromptFragments } from '../../src/config/defaultPromptFragments.js';
import { ShellInvocation } from '../../src/adapters/tool/shell/shellInvocation.js';

/** 取唯一一条提示正文（判据全部针对它）。 */
const promptOf = (platform: string, shell: string): string => {
  const fragments = DefaultPromptFragments.codingAgent({ platform, shell });
  assert.strictEqual(fragments.length, 1, '基础片段数必须保持 1（前缀缓存契约）');
  return fragments[0] ?? '';
};

test('① win32：必须点明 cmd.exe 与 POSIX 禁用词，并给出 %ERRORLEVEL%', () => {
  const text = promptOf('win32', 'C:\\Windows\\system32\\cmd.exe');
  assert.match(text, /win32/, '必须声明平台名');
  assert.match(text, /cmd\.exe/, '必须点明真正的解释器是 cmd.exe');
  assert.match(text, /不是 bash/, '必须显式否定 bash/POSIX 假设');
  for (const forbidden of ['pwd', 'ls', 'cat', 'tail', 'grep']) {
    assert.ok(text.includes(`\`${forbidden}\``), `必须把 ${forbidden} 列进禁用词`);
  }
  assert.match(text, /%ERRORLEVEL%/, '必须给出 cmd 的退出码取法');
  assert.match(text, /dir/, '必须给出 cmd 的等价替代（dir）');
  assert.match(
    text,
    /`&&`/,
    '必须点明 cmd 的分隔符是 && 而不是 ;（实测 `node --version; pwd` 被整体当成一个参数）',
  );
});

test('② POSIX（linux/darwin）：给 POSIX 工具与 $?，且不得出现 cmd.exe', () => {
  for (const platform of ['linux', 'darwin']) {
    const text = promptOf(platform, '/bin/bash');
    assert.match(text, new RegExp(platform), '必须声明平台名');
    assert.ok(text.includes('/bin/bash'), '必须声明真正的 shell');
    assert.match(text, /POSIX/, '必须点明方言');
    assert.match(text, /pwd/, '必须给出可直接用的 POSIX 工具');
    assert.ok(text.includes('$?'), '必须给出 POSIX 退出码取法');
    assert.ok(!text.includes('cmd.exe'), `${platform} 文案不得混入 Windows 方言`);
  }
});

test('③ 两个平台的文案必须不同（防参数没接进正文）', () => {
  assert.notStrictEqual(
    promptOf('win32', 'cmd.exe'),
    promptOf('linux', '/bin/sh'),
    '平台不同而文案相同 ⇒ 运行环境段没真的接上',
  );
});

test('④ 缺省参数取当前进程真实环境（平台与 ShellInvocation 同源）', () => {
  const text = DefaultPromptFragments.codingAgent().join('\n');
  assert.ok(text.includes(process.platform), '缺省必须用 process.platform');
  assert.ok(
    text.includes(ShellInvocation.path()),
    'shell 必须与真正执行命令的 ShellInvocation.path() 同源（不许另写一套分平台分支）',
  );
});

test('⑤ 仍只返回单片段（前缀缓存契约：基础片段数不变）', () => {
  assert.strictEqual(DefaultPromptFragments.codingAgent().length, 1);
});

test('⑥ 子代用「运行环境片段」：含平台与 shell，但不背主会话的整段编码 SOP', () => {
  // 2026-10-06（第六十一轮实测）：子代 `systemPrompt` 曾为 0 token，于是在 cmd.exe 上按 POSIX 试错，
  // 并把「不是内部或外部命令」误判成「隔离 shell 不可用」回传主代理（主代理照抄进最终答复）。
  // 修法：给子代注入**只含运行环境**的那一段——子代工具集被裁剪，整段 SOP 会指向它没有的工具。
  const fragments = DefaultPromptFragments.environmentFragment({
    platform: 'win32',
    shell: 'cmd.exe',
  });
  assert.strictEqual(fragments.length, 1, '子代提示应是单片段');
  const text = fragments[0] ?? '';
  assert.match(text, /win32/);
  assert.match(text, /cmd\.exe/);
  assert.match(text, /%ERRORLEVEL%/, '必须带上该方言的可用替代');
  assert.ok(!text.includes('重新试试'), '子代不该背上主会话的「重新试试」SOP');
  assert.ok(
    !text.includes('选对写工具'),
    '子代提示不得含「选对写工具」这类指向特定工具的 SOP 段（子代工具集是裁剪过的）',
  );
  assert.ok(!text.startsWith('\n'), '片段不应以空行开头（它是一条独立系统消息）');
});
