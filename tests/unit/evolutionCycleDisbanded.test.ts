/**
 * **进化回放环已拆解且不再复活**判据（2026-10-27，环④；与 G25-b `configCycleDisbanded` 同型）。
 *
 * ## 背景
 *
 * `ReplayBuffer` 接口原先声明在实现文件 `src/evolution/rlvrLoop.ts`，而唯一实现
 * `src/evolution/inMemoryReplayBuffer.ts` 必须 `import type` 它 ⇒ 形成 2 成员强连通分量
 * （`rlvrLoop ↔ inMemoryReplayBuffer`，架构门禁白名单「环④ 进化回放组」）。
 *
 * 拆解手法与 2026-10-11 `CodeCandidate` 外迁同型：契约搬进
 * `src/ports/runtime/evolution/replayBuffer.ts`，原位置导入 + 再导出（公开 API 面零改动）。
 *
 * ## 判据
 *
 * | # | 判据 |
 * | --- | --- |
 * | ① | `ReplayBuffer` **确实住在 ports**，且是纯契约（只 import type、无第三方、无 class 实现） |
 * | ② | 原位置 `rlvrLoop.ts` **仍再导出**同名类型（公开 API 面不变，`api:check` 不用改快照） |
 * | ③ | 拆环的关键回边**不得复活**：`inMemoryReplayBuffer` 不得再 import `rlvrLoop` |
 * | ④ | 环组数与白名单**只许收紧**：`architectureGate` 报出的环组数 ≤ 4 且白名单 ≤ 19、不含已出环成员 |
 *
 * 第 ③ 条是核心：它会因"有人图省事把类型挪回实现文件"而变红（架构门禁 [5] 也会红，
 * 但门禁输出是全局摘要，这条把**具体成因**钉在文件级，便于下一个人立刻看懂该往哪修）。
 */
import { test } from 'vitest';
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

test('① ReplayBuffer 契约住在 ports，且是纯声明（无第三方、无 class 实现）', () => {
  const port = read('src/ports/runtime/evolution/replayBuffer.ts');
  assert.match(port, /export interface ReplayBuffer/, 'ports 里应有 ReplayBuffer');
  assert.ok(!/\bclass\b/.test(port), 'ports/replayBuffer.ts 不得含 class 实现（端口只声明契约）');
  for (const line of port.split('\n')) {
    if (line.startsWith('import ')) {
      assert.match(
        line,
        /^import type /,
        `ports/replayBuffer.ts 只允许 import type，实得：${line}`,
      );
    }
    const from = /from '([^']+)'/.exec(line)?.[1];
    if (from !== undefined) {
      assert.ok(
        !/(^|\/)(node:|zod|@modelcontextprotocol)/.test(from),
        `ports/replayBuffer.ts 不得依赖第三方或 node 内置：${from}`,
      );
    }
  }
});

test('② 原位置 rlvrLoop 仍再导出同名类型（公开 API 面不变）', () => {
  assert.match(
    read('src/evolution/rlvrLoop.ts'),
    /export type \{ ReplayBuffer \} from '\.\.\/ports\/runtime\/evolution\/replayBuffer\.ts'/,
    'rlvrLoop 必须再导出 ReplayBuffer（否则是破坏性 API 变更）',
  );
});

test('③ 拆环的关键回边不得复活：inMemoryReplayBuffer 不得再 import rlvrLoop', () => {
  const text = read('src/evolution/inMemoryReplayBuffer.ts');
  assert.ok(
    !/from '\.\/rlvrLoop\.ts'/.test(text),
    'inMemoryReplayBuffer 又反向 import 了 rlvrLoop ⇒ 进化回放环复活（契约应放 ports）',
  );
  assert.match(
    text,
    /from '\.\.\/ports\/runtime\/evolution\/replayBuffer\.ts'/,
    'inMemoryReplayBuffer 应从 ports 直连 ReplayBuffer',
  );
});

test('④ 架构门禁实测：环组 ≤4 且白名单已收紧（不含 2 个已出环成员）', () => {
  const output = execFileSync('node', ['scripts/architectureGate.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const groups = /依赖环：(\d+) 组/.exec(output);
  const members = /白名单成员 (\d+)/.exec(output);
  assert.ok(groups !== null, `架构门禁未报出环组数：${output.slice(0, 200)}`);
  assert.ok(members !== null, '架构门禁未报出白名单成员数');
  assert.ok(
    Number(groups[1]) <= 4,
    `环组数应为 ≤4（环④拆解后实测 4），实得 ${groups[1]} ⇒ 有环复活`,
  );
  assert.ok(
    Number(members[1]) <= 19,
    `白名单成员数应为 ≤19（环④拆解后实测 19），实得 ${members[1]} ⇒ 白名单又被放宽`,
  );
  const gate = read('scripts/architectureGate.mjs');
  for (const member of ["'evolution/inMemoryReplayBuffer'", "'evolution/rlvrLoop'"]) {
    assert.ok(
      !gate.includes(member),
      `白名单里仍留着已出环成员 ${member} ⇒ 陈旧豁免会让下一次回归测不出来`,
    );
  }
});
