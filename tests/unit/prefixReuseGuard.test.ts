/**
 * **前缀复用守卫**（G1b-b，2026-10-03 第六轮）。
 *
 * ## 为什么需要它
 *
 * provider 的前缀缓存（DeepSeek 的 cache prefix unit、Anthropic 的 prompt caching）**要求相邻请求的
 * 序列化前缀逐字节相同**；本仓为此做过一次治理：把 repo-map 这个逐轮变化的动态段**移到消息尾部**，
 * 使「world_state + 常驻指令 + 事件历史」构成稳定头（受控对照实测命中率 ~54% → ~81%）。
 *
 * 但这套性质此前**没有任何机械判据**：`PrefixStability`（仓内唯一的前缀仪器）只被导出、没有生产调用点
 * （报告 §3.2 发现 6），而"前缀稳定"极易被一次无心的重排破坏——把动态段挪回前面、或在头部注入时间戳，
 * 都会静默让缓存命中率崩掉，且**功能测试全绿**（这正是 R1「验证真空」的典型形态）。
 *
 * ## 判据（三条，全部离线、确定性、零 key）
 *
 * 1. **稳定头逐字节不变**：步循环内每次请求的**首条消息**必须与首次完全相同；
 * 2. **首条消息不得含动态段**：不得包含 repo-map 头（`# Repo Map`）——它属于尾部；
 * 3. **只追加、不重写**：相邻请求的**消息数组公共前缀**必须 ≥ `上次长度 − 1`
 *    （上次除尾部动态段外的消息逐条相同）。这条才是前缀缓存的决定性性质；
 *    字符级复用率（`PrefixStability.prefixReuse`）作为**证据**打印，**不设硬地板**——它随
 *    "历史 / 动态段"的相对大小变化，拿它当判据会把"上下文还短"误判成"前缀退化"
 *    （本文件首版就这么误报过，已在 changeset 登记）。
 *
 * ## 口径边界（实测得来，必须随数字引用）
 *
 * 本文件**只覆盖步循环内的请求**：一次回合还会发生**其它形态的模型调用**（如回合末长期记忆抽取，
 * 其首条消息是一条 user 提示），它们与"组装上下文"不是同一序列，混在一起比会把正常行为读成退化
 * （首版即因此误报）。故按 `messages[0].role === 'system'` 过滤出步循环请求再比对。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Agent } from '../../src/core/agent.js';
import { ScriptedModel, type ScriptStep } from '../../src/core/scriptedModel.js';
import { PrefixStability } from '../../src/context/prefixStability.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { Runtime } from '../../src/composition/runtime.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { TOOL_NAMES } from '../../src/ports/tool/toolNames.js';
import { RecordingModel } from '../helpers/recordingModel.js';
import type { ModelMessage } from '../../src/ports/model/model.js';

/** repo-map 动态段的头部标记（出现在首条消息即视为"动态段被挪到了前面"）。 */
const REPO_MAP_HEADER = '# Repo Map';

/**
 * 跑一个多步脚本回合（每步一个只读工具调用，最后收尾）。
 *
 * **语料为什么要"小而真实"**：前缀缓存的风险点在"逐轮变化的动态段"（repo-map）。
 * 空临时工作区里那个段为空 ⇒ "动态段是否被挪到前面"这类断言会**空洞成立**（首版即如此，等于没测）；
 * 而直接用真实仓库根，每步都要派生全仓 repo-map（实测 ~4s/步，整套门禁代价过高）。
 * 折中：把若干个真实源码文件拷进临时工作区——动态段真的存在，派生成本却只有百毫秒级。
 * @param steps 工具步数（≥3 才有足够相邻对比）。
 * @returns "步循环内"的请求序列、字符级复用率证据、工作区路径。
 */
async function runMultiStep(steps: number): Promise<{
  readonly loopRequests: readonly (readonly ModelMessage[])[];
  readonly evidence: string;
  readonly workspace: string;
}> {
  const workspace = mkdtempSync(join(tmpdir(), 'omni-prefix-'));
  const sourceRoot = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'src',
    'context',
  );
  for (const name of readdirSync(sourceRoot).slice(0, 24)) {
    copyFileSync(join(sourceRoot, name), join(workspace, name));
  }
  const script: readonly ScriptStep[] = [
    ...Array.from({ length: steps }, (_unused, i) => ({
      toolCalls: [{ id: `c${String(i)}`, name: TOOL_NAMES.glob, arguments: { pattern: '*.ts' } }],
    })),
    { text: '完成' },
  ];
  const model = new RecordingModel(new ScriptedModel(script, '收尾'));
  const config = ConfigFactory.build({
    workspaceRoot: workspace,
    maxSteps: steps + 2,
    model,
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
  });
  await new Agent(Runtime.createRuntime(config)).runTask('找点文件');
  // 只取"组装上下文"形态的请求：它们恒 ≥2 条；而回合末的记忆抽取 / 兜底总结等**另一次**模型调用
  // 只有单条提示（实测形态，见文件头口径边界）。不按首条角色过滤——有/无项目指令时首条会变
  // （空工作区是 user、有 AGENTS.md 时是 system），按角色过滤会随环境漂移（首版踩过两次）。
  const loopRequests = model.requests
    .map((request) => request.messages)
    .filter((messages) => messages.length >= 2);
  const ratios: string[] = [];
  for (let i = 1; i < loopRequests.length; i++) {
    const previous = JSON.stringify(loopRequests[i - 1]);
    const current = JSON.stringify(loopRequests[i]);
    const percent = (PrefixStability.prefixReuse(previous, current) * 100).toFixed(1);
    ratios.push(`#${String(i)}→#${String(i + 1)} ${percent}%`);
  }
  return { loopRequests, evidence: ratios.join('  '), workspace };
}

/**
 * 两个消息数组的公共前缀长度（逐条 JSON 比较）。
 * @param a 上一次请求的消息。
 * @param b 本次请求的消息。
 * @returns 逐条相同的消息条数。
 */
function commonMessages(a: readonly ModelMessage[], b: readonly ModelMessage[]): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && JSON.stringify(a[i]) === JSON.stringify(b[i])) {
    i += 1;
  }
  return i;
}

test('① 稳定头逐字节不变：步循环内每次请求的首条消息必须与首次完全相同', async () => {
  const { loopRequests, workspace } = await runMultiStep(3);
  try {
    assert.ok(
      loopRequests.length >= 3,
      `至少要有 3 次组装上下文请求才有相邻对比，实得 ${String(loopRequests.length)}`,
    );
    const first = JSON.stringify(loopRequests[0]?.[0]);
    for (let i = 1; i < loopRequests.length; i++) {
      assert.strictEqual(
        JSON.stringify(loopRequests[i]?.[0]),
        first,
        `第 ${String(i + 1)} 次请求的首条消息与首次不同 ⇒ 稳定头被扰动，前缀缓存会整段失效`,
      );
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('② 首条消息不得含动态段（repo-map 属于尾部，挪到前面会让每步前缀全变）', async () => {
  const { loopRequests, workspace } = await runMultiStep(2);
  try {
    for (let i = 0; i < loopRequests.length; i++) {
      const head = JSON.stringify(loopRequests[i]?.[0] ?? {});
      assert.ok(
        !head.includes(REPO_MAP_HEADER),
        `第 ${String(i + 1)} 次请求的首条消息含动态段（${REPO_MAP_HEADER}）⇒ 前缀缓存必然失效`,
      );
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('③ 只追加不重写：相邻请求的消息数组公共前缀 ≥ 上次长度 − 1（尾部动态段允许变化）', async () => {
  const { loopRequests, evidence, workspace } = await runMultiStep(3);
  try {
    // 防"空洞通过"：过滤条件若失配（0 次请求），下面的循环会一次都不执行而假装全绿——
    // 本文件首版就出过这个形态（`messages[0].role === 'system'` 过滤把全部请求都滤掉了）。
    assert.ok(
      loopRequests.length >= 3,
      `至少要有 3 次组装上下文请求才有相邻对比，实得 ${String(loopRequests.length)}（过滤条件失配会空洞通过）`,
    );
    for (let i = 1; i < loopRequests.length; i++) {
      const previous = loopRequests[i - 1] ?? [];
      const current = loopRequests[i] ?? [];
      const common = commonMessages(previous, current);
      assert.ok(
        common >= previous.length - 1,
        `第 ${String(i)}→${String(i + 1)} 步重写了头部：公共前缀 ${String(common)} 条 < 上次 ${String(previous.length)} 条 − 1` +
          '（只允许尾部动态段变化；头部被重写会让前缀缓存从改动点起全部失效）',
      );
    }
    // 证据行：字符级复用率随"历史/动态段"相对大小变化，只报不判（口径见文件头）。
    console.log(
      `[前缀复用] 步循环请求 ${String(loopRequests.length)} 次；字符级复用率 ${evidence}（该数字被尾部动态段体积稀释，仅作证据；判据是上面的结构不变量）`,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
