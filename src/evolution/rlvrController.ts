/**
 * RLVR 进化控制器组合器（U4 升格的实质落点）。
 *
 * 把三段原本孤立的能力钉成一条真闭环：
 *   1. TwistDiscoveryEngine（燧-1 莫尔组合，有界发现候选技能）
 *   2. FailClosedEvolutionGate（fail-closed 门禁，可注入「可验证奖励」基准）
 *   3. RlvrLoop（StarPO sample-filter-replay：模型采样代码变体 → 可验证奖励打分 → 绿样本进回放缓冲）
 *
 * 关键桥接：U4 两个孤儿模块（`verifiableReward` 的 skill 型奖励 ↔ `RlvrLoop` 的代码型采样）
 * 通过 `verifiableRewardForCode` 接通——RLVR 的奖励来自「把候选代码写入临时文件后真实编译/测试绿度」，
 * 而非 LLM 主观评判或结构启发式。过门禁的候选还需 RLVR 阶段产生「绿」样本才晋升（fail-closed 否决）。
 *
 * 零第三方依赖；模型采样器 fail-closed（生成失败 → 该样本不参与回放）。
 */
import type { Candidate } from '../ports/evolution.js';
import type { ModelPort } from '../ports/model.js';
import type { Skill, MoireOptions } from '../skill/skill.js';
import type { Benchmark } from './failClosedEvolutionGate.js';
import { moireEnergy } from './benchmark.js';
import { FailClosedEvolutionGate } from './failClosedEvolutionGate.js';
import { TwistDiscoveryEngine } from './twistDiscoveryEngine.js';
import { EvolutionControllerImpl } from './evolutionControllerImpl.js';
import type { EvolutionController } from '../ports/evolution.js';
import { RlvrLoop, InMemoryReplayBuffer } from './rlvrLoop.js';
import type { RlvrSampler, ReplayBuffer, CodeCandidate } from './rlvrLoop.js';
import { verifiableRewardForCode } from './verifiableReward.js';

/** 构造选项。 */
export interface RlvrEvolutionOptions {
  /** 候选技能池（供燧-1 组合发现）。 */
  readonly skills: readonly Skill[];
  /** 莫尔组合算子（通常注入 skillRegistry.composeByTwist）。 */
  readonly compose: (a: Skill, b: Skill, opts?: MoireOptions) => Skill;
  /** 代码采样模型（生成 RLVR 候选代码变体）。 */
  readonly model: ModelPort;
  /** 发现预算上限（默认 12）。 */
  readonly maxCandidates?: number;
  /** 每 prompt 采样数（默认 8）。 */
  readonly samplesPerPrompt?: number;
  /** RLVR 最低保留阈值（默认 0：仅保留 reward>0 的绿样本）。 */
  readonly minReward?: number;
  /**
   * 候选代码验证命令（含 `%CODE_FILE%` 占位符，运行时会替换为临时文件路径）。
   * 如 `npx tsc --noEmit %CODE_FILE%`。缺省则 RLVR 奖励恒 0（无样本进回放，fail-closed 安全）。
   */
  readonly verifyCommand?: string;
  /** 能力场边长（透传燧-1）。 */
  readonly fieldSize?: number;
  /** 门禁基准（skill 级 0..1；缺省 fail-closed 0 → 无候选晋升，安全旁路）。 */
  readonly gateBenchmark?: Benchmark;
  /** 晋升回调。 */
  readonly onPromote?: (candidate: Candidate) => void;
  /** 任务末自动进化（默认 false）。 */
  readonly autoRun?: boolean;
}

/** 返回包：控制器 + 回放缓冲（供后续策略更新/观测绿样本）。 */
export interface RlvrEvolutionBundle {
  readonly controller: EvolutionController;
  readonly buffer: ReplayBuffer;
}

/** 从代码块/文本抽取首个 ```lang ... ``` 代码，否则返回原文。 */
export function extractCodeFence(text: string): string {
  const m = text.match(/```[^\n]*\n([\s\S]*?)```/);
  if (m !== null) return m[1]!.trim();
  return text.trim();
}

/** 模型后端 RLVR 采样器：对第 index 个候选调用模型生成代码变体（fail-closed：失败返回伪样本）。 */
export function modelRlvrSampler(model: ModelPort, samplesPerPrompt: number): RlvrSampler {
  return {
    sample(
      prompt: string,
      index: number,
    ): CodeCandidate | undefined | Promise<CodeCandidate | undefined> {
      if (index >= samplesPerPrompt) return undefined;
      return (async (): Promise<CodeCandidate> => {
        try {
          const out = await model.generate({
            messages: [
              {
                role: 'user',
                content: `Write code only (no prose, no explanation) implementing:\n${prompt}`,
              },
            ],
            tools: [],
          });
          const code = extractCodeFence(out.text ?? '');
          return {
            id: `s${index}`,
            code: code.length > 0 ? code : '// empty generation',
            meta: { prompt },
          };
        } catch {
          // fail-closed：生成失败 → 伪样本（reward 0，不进回放），不中止整轮。
          return { id: `s${index}`, code: '// generation error', meta: { prompt } };
        }
      })();
    },
  };
}

/** 从进化候选抽取 RLVR prompt（描述该技能应实现什么）。 */
function promptForCandidate(c: Candidate): string {
  const intent = (c.skill.instructions ?? '').slice(0, 240);
  return `Implement a reusable capability named "${c.skill.name}". Intent: ${intent}`;
}

/**
 * 构造带「可验证门禁 + RLVR sample-filter-replay」的进化控制器（U4 真接进进化闭环）。
 */
export function createRlvrEvolutionController(opts: RlvrEvolutionOptions): RlvrEvolutionBundle {
  const buffer: ReplayBuffer = new InMemoryReplayBuffer();
  const sampler = modelRlvrSampler(opts.model, opts.samplesPerPrompt ?? 8);
  const reward =
    opts.verifyCommand !== undefined
      ? verifiableRewardForCode(() => opts.verifyCommand)
      : () => Promise.resolve(0);
  const loop = new RlvrLoop({
    sampler,
    reward,
    buffer,
    samplesPerPrompt: opts.samplesPerPrompt ?? 8,
    minReward: opts.minReward,
  });
  const discovery = new TwistDiscoveryEngine({
    skills: opts.skills,
    compose: opts.compose,
    maxCandidates: opts.maxCandidates ?? 12,
    fieldSize: opts.fieldSize,
  });
  const gate = new FailClosedEvolutionGate({
    // 默认门禁基准：候选技能是否携带复合（莫尔）结构（moireEnergy）；缺省安全旁路由调用方注入更针对性基准。
    benchmark: opts.gateBenchmark ?? ((c: Candidate) => moireEnergy(c.skill, 32)),
  });
  const controller = new EvolutionControllerImpl({
    discovery,
    gate,
    onPromote: opts.onPromote,
    autoRun: opts.autoRun ?? false,
    rlvr: { loop, promptFor: promptForCandidate },
  });
  return { controller, buffer };
}
