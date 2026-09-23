/**
 * 工具名**单一来源**的回归（用户指令，2026-09-22 第三轮；审计 §3.4 的收口项）。
 *
 * 被改的形态：工具名字面量「两头都写」——注册侧每个工具类写一遍 `name: 'read_file'`，
 * 消费侧的策略表（`MUTATING_TOOLS`、plan 只读白名单、调度器、信任分级、diff 钩子、默认审批规则、
 * 评估夹具…）再写一遍。改一个名字要改多处，**漏改策略表不报错**，只会让
 * 「写类必须串行 / plan 必须拦」这类安全契约对该工具静默失效（§20.8 实测过同批并发）。
 *
 * 本测试钉住四件事：
 * ① 表本身健康：值唯一、格式合法、与历史字面量逐字一致；
 * ② 域内常量（LSP / goal / workflow / policy_eval / agent_identity）**指向同一张表**；
 * ③ **反硬编码守卫（策略面）**：策划分级模块里不得再出现工具名字面量（注释除外）；
 * ④ **反硬编码守卫（注册面）**：工具类不得写 `name: '<字面量>'`，必须走 `TOOL_NAMES.*`。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUTATING_TOOL_NAMES, TOOL_NAMES, type ToolName } from '../../src/ports/tool/toolNames.js';
import { MUTATING_TOOLS } from '../../src/core/toolGate.js';
import {
  LSP_STATUS_TOOL_NAME,
  LSP_WORKSPACE_SYMBOLS_TOOL_NAME,
} from '../../src/adapters/lsp/lspToolNames.js';
import { RUN_GOAL_TOOL_NAME } from '../../src/autonomy/goalToolNames.js';
import { RUN_WORKFLOW_TOOL_NAME } from '../../src/autonomy/workflowToolNames.js';
import { POLICY_EVAL_TOOL_NAME } from '../../src/adapters/tool/meta/policyEvalTool.js';
import { AGENT_IDENTITY_TOOL_NAME } from '../../src/adapters/tool/meta/agentIdentityTool.js';
import { MutationTargets } from '../../src/adapters/tool/verify/mutationTargets.js';
import { TRACKED_WRITE_TOOLS } from '../../src/adapters/diff/turnDiffHooks.js';

/** 仓库根（dist/tests/unit → 上溯三级）。 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 历史关键值（改造前写在实现里），作为不可漂移的期望值。 */
const EXPECTED: Readonly<Record<string, string>> = {
  readFile: 'read_file',
  listDir: 'list_dir',
  grep: 'grep',
  glob: 'glob',
  writeFile: 'write_file',
  edit: 'edit',
  applyPatch: 'apply_patch',
  shell: 'shell',
  shellJob: 'shell_job',
  shellInteractive: 'shell_interactive',
  runCode: 'run_code',
  delegate: 'delegate',
  subagent: 'subagent',
  browserScreenshot: 'browser_screenshot',
  rollback: 'rollback',
  checkpoint: 'checkpoint',
  remember: 'remember',
  recall: 'recall',
  memorySearch: 'memory_search',
  webSearch: 'web_search',
  webFetch: 'web_fetch',
  toolSearch: 'tool_search',
  spillRead: 'spill_read',
  viewImage: 'view_image',
  askUser: 'ask_user',
  policyEval: 'policy_eval',
  agentIdentity: 'agent_identity',
  runGoal: 'run_goal',
  runWorkflow: 'run_workflow',
};

/** 必须走 `TOOL_NAMES.*` 的策划分级模块（工具名硬编码曾在此造成口径漂移）。 */
const POLICY_MODULES = [
  'src/core/toolGate.ts',
  'src/core/toolExposurePlanner.ts',
  'src/security/toolOutputTrust.ts',
  'src/adapters/approval/planApproval.ts',
  'src/adapters/approval/cachedApproval.ts',
  'src/adapters/diff/turnDiffHooks.ts',
  'src/adapters/tool/verify/mutationTargets.ts',
  'src/eval/builtinSuites.ts',
  'src/adapters/model/mockModel.ts',
  'src/autonomy/workflowRunner.ts',
];

/**
 * 找出某文件里「整串恰等于某个工具名」的字面量（带**真实行号**）。
 *
 * `keywords: [...]` 块整体跳过：那是**任务文本的匹配模式**（英文词边界 / 中文子串），
 * 里面出现 `'edit'` / `'grep'` / `'shell'` 是词法模式而不是工具名——替换成 `TOOL_NAMES.*`
 * 虽值相同，却会让「这是模式」的语义被误读。只有 `tools: [...]` 之类的**工具清单**才是目标。
 * @param absFile 目标文件绝对路径。
 * @param display 报错时展示的路径（相对仓库根）。
 * @param values 工具名全集。
 * @returns 违规列表（空 = 干净）。
 */
const toolNameLiteralsIn = (
  absFile: string,
  display: string,
  values: ReadonlySet<string>,
): string[] => {
  const lines = readFileSync(absFile, 'utf8').split(/\r?\n/);
  const out: string[] = [];
  let inKeywords = false;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (inKeywords) {
      if (trimmed.startsWith(']')) inKeywords = false;
      return;
    }
    if (/keywords:\s*\[/.test(line)) {
      inKeywords = true;
      return;
    }
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
    // `id:` / `hint:` 是类别标识与文案，不是工具名（可能恰好同名，如 `id: 'delegate'`）。
    if (/^(id|hint):\s*'/.test(trimmed)) return;
    for (const m of line.matchAll(/'([a-z][a-z0-9_]*)'/g)) {
      if (values.has(m[1] ?? '')) out.push(`${display}:${index + 1}  '${m[1]}'`);
    }
  });
  return out;
};

test('① 工具名表：值唯一、格式合法、与历史字面量逐字一致', () => {
  const values = Object.values(TOOL_NAMES);
  assert.strictEqual(new Set(values).size, values.length, 'TOOL_NAMES 的值必须唯一');
  for (const value of values) {
    assert.match(value, /^[a-z][a-z0-9_]*$/, `工具名格式非法：${value}`);
  }
  for (const [key, value] of Object.entries(EXPECTED)) {
    assert.strictEqual(
      (TOOL_NAMES as Record<string, string>)[key],
      value,
      `${key} 必须与历史字面量一致（改名属破坏性变更）`,
    );
  }
  // 写类单一口径：端口层与 core 层必须是同一集合内容
  const mutating = [...MUTATING_TOOL_NAMES].sort();
  assert.deepStrictEqual([...MUTATING_TOOLS].sort(), mutating);
  for (const name of [
    TOOL_NAMES.shell,
    TOOL_NAMES.writeFile,
    TOOL_NAMES.edit,
    TOOL_NAMES.applyPatch,
    TOOL_NAMES.rollback,
    TOOL_NAMES.checkpoint,
    TOOL_NAMES.remember,
    TOOL_NAMES.browserScreenshot,
  ] as ToolName[]) {
    assert.ok(MUTATING_TOOL_NAMES.has(name), `写类工具漏收：${name}`);
  }
  // 只读工具不得混入写类集合
  assert.ok(!MUTATING_TOOL_NAMES.has(TOOL_NAMES.readFile));
  assert.ok(!MUTATING_TOOL_NAMES.has(TOOL_NAMES.grep));
});

test('② 域内常量与其它口径表都指向同一张表', () => {
  assert.strictEqual(LSP_STATUS_TOOL_NAME, TOOL_NAMES.lspStatus);
  assert.strictEqual(LSP_WORKSPACE_SYMBOLS_TOOL_NAME, TOOL_NAMES.lspWorkspaceSymbols);
  assert.strictEqual(RUN_GOAL_TOOL_NAME, TOOL_NAMES.runGoal);
  assert.strictEqual(RUN_WORKFLOW_TOOL_NAME, TOOL_NAMES.runWorkflow);
  assert.strictEqual(POLICY_EVAL_TOOL_NAME, TOOL_NAMES.policyEval);
  assert.strictEqual(AGENT_IDENTITY_TOOL_NAME, TOOL_NAMES.agentIdentity);
  // 落盘工具集（diff 追踪 / 变更目标解析）两者同口径
  for (const name of [TOOL_NAMES.writeFile, TOOL_NAMES.edit, TOOL_NAMES.applyPatch]) {
    assert.ok(MutationTargets.WRITE_TOOLS.has(name), `MutationTargets 漏收 ${name}`);
    assert.ok(TRACKED_WRITE_TOOLS.has(name), `TRACKED_WRITE_TOOLS 漏收 ${name}`);
  }
});

test('③ 反硬编码守卫（策略面）：策划分级模块不得再出现工具名字面量', () => {
  const values = new Set<string>(Object.values(TOOL_NAMES));
  const offenders = POLICY_MODULES.flatMap((rel) =>
    toolNameLiteralsIn(join(repoRoot, rel), rel, values),
  );
  assert.deepStrictEqual(
    offenders,
    [],
    `策划分级模块必须用 TOOL_NAMES.* 而不是字面量：\n${offenders.join('\n')}`,
  );
});

test('④ 反硬编码守卫（注册面）：工具类不得写 name 字面量', () => {
  const values = new Set<string>(Object.values(TOOL_NAMES));
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue;
      if (name === 'registryToolPort.ts') continue; // 端口名（非工具名）刻意保留字面量，见其类注释
      const rel = relative(repoRoot, full).split(sep).join('/');
      // 只认 `name: '<工具名>'` / `name = '<工具名>'` 两种形态，避免误伤其它字符串。
      readFileSync(full, 'utf8')
        .split(/\r?\n/)
        .forEach((line, index) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
            return;
          }
          for (const m of line.matchAll(/(?:name:\s*|name = )'([a-z][a-z0-9_]*)'/g)) {
            if (values.has(m[1] ?? '')) offenders.push(`${rel}:${index + 1}  '${m[1]}'`);
          }
        });
    }
  };
  walk(join(repoRoot, 'src', 'adapters', 'tool'));
  assert.deepStrictEqual(
    offenders,
    [],
    `工具类必须写 name: TOOL_NAMES.*（新增工具请先在 ports/tool/toolNames.ts 登记）：\n${offenders.join('\n')}`,
  );
});
