/**
 * **配置子环已拆解且不再复活**判据（G25-b，2026-10-03 第二十八轮）。
 *
 * ## 背景
 *
 * G25 把 20 成员的「装配-运行时大环」拆掉后，残留一个 4 成员**配置子环**：
 * `configBuilder → configFactory → configToolRegistry/corePortsAssembler → configBuilder`。
 * 成因是**类型住在实现文件里**：`SubagentPortSeed`（内含 `MediaStack`）声明在 `configFactory.ts`，
 * 于是 `configBuilder` / `configToolRegistry` 必须反向 import 它。
 *
 * G25-b 把两个类型搬进 ports：
 * `src/ports/config/subagentPortSeed.ts` + `src/ports/media/mediaStack.ts`。
 *
 * ## 判据
 *
 * | # | 判据 |
 * | --- | --- |
 * | ① | 两个类型**确实住在 ports**，且是纯契约（只 import type、无第三方、无 class 实现） |
 * | ② | 两个原位置**仍再导出**同名类型（公开 API 面不变，`api:check` 不用改快照） |
 * | ③ | 拆环的关键回边**不得复活**：`configBuilder` / `configToolRegistry` 不得再 import `configFactory` |
 * | ④ | 环组数与白名单**只许收紧**：`architectureGate` 报出的环组数 ≤ 5 且白名单不含这 4 个已出环的成员 |
 *
 * 第 ③ 条是本判据的核心：它会因"有人图省事把类型挪回实现文件"而变红（架构门禁 [5] 也会红，
 * 但门禁的输出是全局摘要，这条把**具体成因**钉在文件级，便于下一个人立刻看懂该往哪修）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 仓库根。 */
const ROOT = process.cwd();

/**
 * 读仓库内文本文件。
 * @param rel 相对仓库根路径。
 * @returns 文件内容。
 */
function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

test('① 两个契约类型住在 ports，且是纯声明（无第三方、无 class 实现）', () => {
  const seed = read('src/ports/config/subagentPortSeed.ts');
  const stack = read('src/ports/media/mediaStack.ts');
  assert.match(seed, /export type SubagentPortSeed/, 'ports 里应有 SubagentPortSeed');
  assert.match(stack, /export interface MediaStack/, 'ports 里应有 MediaStack');
  for (const [name, text] of [
    ['subagentPortSeed', seed],
    ['mediaStack', stack],
  ] as const) {
    assert.ok(!/\bclass\b/.test(text), `ports/${name}.ts 不得含 class 实现（端口只声明契约）`);
    for (const line of text.split('\n')) {
      if (line.startsWith('import ')) {
        assert.match(line, /^import type /, `ports/${name}.ts 只允许 import type，实得：${line}`);
      }
    }
    for (const line of text.split('\n')) {
      const from = /from '([^']+)'/.exec(line)?.[1];
      if (from !== undefined) {
        assert.ok(
          !/(^|\/)(node:|zod|@modelcontextprotocol)/.test(from),
          `ports/${name}.ts 不得依赖第三方或 node 内置：${from}`,
        );
      }
    }
  }
});

test('② 原位置仍再导出同名类型（公开 API 面不变）', () => {
  assert.match(
    read('src/config/configFactory.ts'),
    /export type \{ SubagentPortSeed \} from '\.\.\/ports\/config\/subagentPortSeed\.js'/,
    'configFactory 必须再导出 SubagentPortSeed（否则是破坏性 API 变更）',
  );
  assert.match(
    read('src/config/mediaStackAssembler.ts'),
    /export type \{ MediaStack \} from '\.\.\/ports\/media\/mediaStack\.js'/,
    'mediaStackAssembler 必须再导出 MediaStack（否则是破坏性 API 变更）',
  );
});

test('③ 拆环的关键回边不得复活：两个装配文件不得再 import configFactory', () => {
  for (const rel of ['src/config/configBuilder.ts', 'src/config/configToolRegistry.ts']) {
    const text = read(rel);
    assert.ok(
      !/from '\.\/configFactory\.js'/.test(text),
      `${rel} 又反向 import 了 configFactory ⇒ 配置子环复活（类型应放 ports，不放实现文件）`,
    );
    assert.match(
      text,
      /from '\.\.\/ports\/config\/subagentPortSeed\.js'/,
      `${rel} 应从 ports 直连 SubagentPortSeed`,
    );
  }
});

test('④ 架构门禁实测：环组 ≤5 且白名单已收紧（不含 4 个已出环成员）', () => {
  const output = execFileSync('node', ['scripts/architectureGate.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const groups = /依赖环：(\d+) 组/.exec(output);
  const members = /白名单成员 (\d+)/.exec(output);
  assert.ok(groups !== null, `架构门禁未报出环组数：${output.slice(0, 200)}`);
  assert.ok(members !== null, '架构门禁未报出白名单成员数');
  assert.ok(
    Number(groups[1]) <= 5,
    `环组数应为 ≤5（G25-b 后实测 5），实得 ${groups[1]} ⇒ 有环复活`,
  );
  assert.ok(
    Number(members[1]) <= 21,
    `白名单成员数应为 ≤21（G25-b 后实测 21），实得 ${members[1]} ⇒ 白名单又被放宽`,
  );
  const gate = read('scripts/architectureGate.mjs');
  for (const member of [
    "'config/configBuilder'",
    "'config/configFactory'",
    "'config/configToolRegistry'",
    "'config/corePortsAssembler'",
  ]) {
    assert.ok(
      !gate.includes(member),
      `白名单里仍留着已出环成员 ${member} ⇒ 陈旧豁免会让下一次回归测不出来`,
    );
  }
});
