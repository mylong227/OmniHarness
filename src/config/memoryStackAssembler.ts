import { join } from 'node:path';

import type { ModelPort } from '../ports/model.js';
import type { LongTermMemoryPort } from '../ports/longTermMemory.js';
import type { CosmicWebPort } from '../ports/cosmicWeb.js';
import type { ResonantMemoryPort } from '../ports/resonantMemory.js';
import type { MemoryAnnealer } from '../ports/memoryAnnealing.js';

import { FileLongTermMemory } from '../adapters/memory/fileLongTermMemory.js';
import { MemoryExtractor } from '../adapters/memory/memoryExtractor.js';
import { AesGcmTextCodec } from '../adapters/memory/aesGcmTextCodec.js';
import { ResonantMemoryEngine } from '../adapters/memory/resonantMemoryEngine.js';
import { ResonantFieldEngine } from '../adapters/memory/resonantFieldEngine.js';
import { HeatEquationAnnealer } from '../adapters/memory/heatEquationAnnealer.js';
import { CosmicWebMemoryEngine } from '../adapters/memory/cosmicWebMemoryEngine.js';
import { QECEncoder } from '../adapters/memory/qecEncoder.js';
import { ImmuneMonitor } from '../adapters/monitoring/immuneMonitor.js';
import { NaturalGradientBelief } from '../adapters/belief/naturalGradientBelief.js';
import { ParticleFilterBelief } from '../adapters/belief/particleFilterBelief.js';

import type { OmniHarnessConfig } from './configFactory.js';

/**
 * 长期记忆栈切片：直接并入 `ResolvedConfig` 的字段子集。
 * `longTermMemory` 已是「最终封包」端口（可能被共振场 / 宇宙网 / 共振引擎包裹），
 * 下游（工具、蒸馏器、燧内核）共用同一实例，保证单一状态源。
 */
export interface MemoryStack {
  readonly longTermMemory: LongTermMemoryPort;
  /** 回合末蒸馏器（#S28，可选）：模型存在且未关自动沉淀时构造，否则 undefined。 */
  readonly memoryExtractor: MemoryExtractor | undefined;
  /** (D) 热方程记忆退火器（可选）：`memoryAnnealing.enabled` 时构造。 */
  readonly annealer: MemoryAnnealer | undefined;
  /** (E, I-P1-3) QEC 记忆编码器（可选）：`qec.enabled` 时构造。 */
  readonly qecEncoder: QECEncoder | undefined;
  /** (E, I-P1-5) 免疫异常监控器（可选）：`immuneMonitoring.enabled` 时构造。 */
  readonly immune: ImmuneMonitor | undefined;
  /** (P2, I-P2-2) 自然梯度信念引擎（可选）：`belief` 含该算法时构造。 */
  readonly naturalGradient: NaturalGradientBelief | undefined;
  /** (P2, I-P2-3) 粒子滤波信念引擎（可选）：`belief` 含该算法时构造。 */
  readonly particleFilter: ParticleFilterBelief | undefined;
  /** (E, I-P1-2) 宇宙网记忆引擎（可选）：`memoryWeb` 或 U1 统一基板启用时构造。 */
  readonly web: CosmicWebPort | undefined;
}

/**
 * 记忆栈中仅 `SparkController` 消费的内部件：不进 `ResolvedConfig`
 * （燧内核是它们唯一的编排者，暴露到配置面只会造成双写口径）。
 */
export interface MemorySparkInput {
  /** 燧-3 共振寻址引擎（U1 统一基板下与 `web` 同一实例）。 */
  readonly resonance: ResonantMemoryPort | undefined;
  /** 免疫「自体」采样器：每轮自检观测的 3 维行为向量（均值/离散度/条数）。 */
  readonly immuneSample: (() => readonly number[]) | undefined;
  /** 信念「自体」采样器：每轮经 `correct` 观测的 3 维行为向量（维度须与信念引擎一致）。 */
  readonly beliefObservation: (() => readonly number[]) | undefined;
}

/** 记忆栈装配结果：配置切片 + 燧专用内部件。 */
export interface MemoryStackAssembly {
  /** 并入 `ResolvedConfig` 的记忆栈切片。 */
  readonly stack: MemoryStack;
  /** 仅供 SparkController 装配的内部件。 */
  readonly sparkInput: MemorySparkInput;
}

/** 已逐层封包的长期记忆端口及其包装层句柄。 */
interface MemoryPortStack {
  readonly port: LongTermMemoryPort;
  readonly web: (CosmicWebPort & LongTermMemoryPort) | undefined;
  readonly resonance: (ResonantMemoryPort & LongTermMemoryPort) | undefined;
}

/** 信念引擎组。 */
interface BeliefEngines {
  readonly naturalGradient: NaturalGradientBelief | undefined;
  readonly particleFilter: ParticleFilterBelief | undefined;
}

/**
 * 装配长期记忆栈（组合根一侧）。
 *
 * 负责「基础存储 → 加密 → 能力封包（共振场 / 宇宙网 / 共振）→ 知识基础算子（退火 / QEC / 免疫 / 信念）」
 * 这条有序装配链。顺序敏感：知识算子必须拿到**最终封包**的长期记忆端口才能与主循环共用同一状态源。
 *
 * 统一基板（U1）优先：`resonantField.enabled !== false` 时以单一 `ResonantFieldEngine` 同时充当
 * 共振寻址与宇宙网（消除双重频谱索引）；仅显式 `enabled: false` 才回落到分别启用。
 *
 * @param partial 未解析的运行配置。
 * @param model 已装配的模型端口（供回合末蒸馏器使用；undefined 则只支持显式 remember）。
 * @returns 记忆栈切片 + 燧专用内部件。
 */
export function assembleMemoryStack(
  partial: OmniHarnessConfig,
  model: ModelPort | undefined,
): MemoryStackAssembly {
  const memory = buildMemoryPort(partial);
  const annealer = buildAnnealer(partial, memory.port);
  const qecEncoder =
    partial.qec?.enabled === true ? new QECEncoder(memory.port, { cols: partial.qec.cols }) : undefined;
  const immune =
    partial.immuneMonitoring?.enabled === true
      ? new ImmuneMonitor({ threshold: partial.immuneMonitoring.threshold })
      : undefined;
  const belief = buildBelief(partial);
  const memoryExtractor =
    partial.memoryConsolidate !== false && model !== undefined
      ? new MemoryExtractor(model, memory.port, {
          maxFactsPerTurn: partial.memoryConsolidateMaxFacts,
        })
      : undefined;
  const beliefEnabled = belief.naturalGradient !== undefined || belief.particleFilter !== undefined;
  return {
    stack: {
      longTermMemory: memory.port,
      memoryExtractor,
      annealer,
      qecEncoder,
      immune,
      naturalGradient: belief.naturalGradient,
      particleFilter: belief.particleFilter,
      web: memory.web,
    },
    sparkInput: {
      resonance: memory.resonance,
      immuneSample: immune === undefined ? undefined : immuneSampleOf(memory.port),
      beliefObservation: beliefEnabled ? beliefObservationOf(memory.port) : undefined,
    },
  };
}

/**
 * 构造长期记忆端口并逐层封包。
 * #S28 默认文件落盘；#4.4 开启加密则用 AES-256-GCM 逐行加密（密钥文件缺省自动生成）。
 * U1 统一基板（默认开）→ 否则分别按 `memoryWeb` / `resonance` 封包。
 */
function buildMemoryPort(partial: OmniHarnessConfig): MemoryPortStack {
  const memoryPath =
    partial.longTermMemoryPath ??
    join(partial.workspaceRoot, '.omniharness', 'longterm', 'memory.jsonl');
  let port: LongTermMemoryPort =
    partial.longTermMemory ??
    new FileLongTermMemory(
      memoryPath,
      partial.longTermMemoryEncryption === true
        ? new AesGcmTextCodec({
            keyFile:
              partial.longTermMemoryKeyFile ??
              join(partial.workspaceRoot, '.omniharness', 'longterm', 'memory.key'),
          })
        : undefined,
    );
  // 统一基板（U1，默认开启）：把长期记忆封包成单一 ResonantField 引擎，合并 燧-3 共振寻址
  // 与宇宙网（Burgers 黏附去重 + RG 坍缩 + 纤维召回），消除双重频谱索引；同一实例同时喂给
  // SparkController 的 resonance 与 web，保证 RG 坍缩与调谐在任务末真实运行。显式 enabled:false 才关。
  if (partial.resonantField?.enabled !== false) {
    const field = new ResonantFieldEngine(port, {
      adhesionThreshold: partial.resonantField?.adhesionThreshold,
      bekensteinCap: partial.resonantField?.bekensteinCap,
    });
    return { port: field, web: field, resonance: field };
  }
  // 宇宙网记忆（E, I-P1-2）：写入走 Burgers 黏附去重、consolidate 走 RG 粗粒化坍缩
  // （节点数受 Bekenstein 容量界约束、存储不膨胀）。
  let web: (CosmicWebPort & LongTermMemoryPort) | undefined;
  if (partial.memoryWeb?.enabled === true) {
    web = new CosmicWebMemoryEngine(port, {
      adhesionThreshold: partial.memoryWeb.adhesionThreshold,
      bekensteinCap: partial.memoryWeb.bekensteinCap,
    });
    port = web;
  }
  // 燧-3 共振寻址（S+）：把（可能已被宇宙网封包的）长期记忆再封为共振引擎，
  // 使开场 primer 召回、recall 工具、回合末蒸馏全部自动走频率域共振代数（取代 BM25 几何召回）。
  let resonance: (ResonantMemoryPort & LongTermMemoryPort) | undefined;
  if (partial.resonance?.enabled === true) {
    resonance = new ResonantMemoryEngine(port, 257);
    port = resonance;
  }
  return { port, web, resonance };
}

/**
 * (D) 热方程记忆退火器：`memoryAnnealing.enabled` 时对（最终封包的）长期记忆构造退火器，
 * 任务末经 SparkController 跑频率域共振耦合的热方程扩散 + 温度退火。零侵入主循环。
 */
function buildAnnealer(
  partial: OmniHarnessConfig,
  port: LongTermMemoryPort,
): HeatEquationAnnealer | undefined {
  if (partial.memoryAnnealing?.enabled !== true) {
    return undefined;
  }
  return new HeatEquationAnnealer(port, {
    coupling: partial.memoryAnnealing.coupling,
    initialTemperature: partial.memoryAnnealing.initialTemperature,
    coolingRate: partial.memoryAnnealing.coolingRate,
    decay: partial.memoryAnnealing.decay,
    resonanceThreshold: partial.memoryAnnealing.resonanceThreshold,
    maxFacts: partial.memoryAnnealing.maxFacts,
  });
}

/**
 * (P2, I-P2-2/3) 信念支柱：按 `belief.algorithm` 构造自然梯度 / 粒子滤波信念引擎，
 * 对「自体」行为向量周期做可审计 KL 分解更新（信息几何）。缺省不构造，零破坏。
 */
function buildBelief(partial: OmniHarnessConfig): BeliefEngines {
  if (partial.belief?.enabled !== true) {
    return { naturalGradient: undefined, particleFilter: undefined };
  }
  const algorithm = partial.belief.algorithm ?? 'both';
  const dim = partial.belief.dim ?? 3;
  return {
    naturalGradient:
      algorithm === 'natural-gradient' || algorithm === 'both'
        ? new NaturalGradientBelief({ dim, initialVariance: partial.belief.initialVariance })
        : undefined,
    particleFilter:
      algorithm === 'particle-filter' || algorithm === 'both'
        ? new ParticleFilterBelief({
            dim,
            particles: partial.belief.particles,
            initialVariance: partial.belief.initialVariance,
          })
        : undefined,
  };
}

/** 免疫「自体」采样器：记忆健康度 3 维向量（重要性均值/标准差/条数）；空记忆时全零。 */
function immuneSampleOf(port: LongTermMemoryPort): () => readonly number[] {
  return () => {
    const facts = port.all();
    if (facts.length === 0) return [0, 0, 0];
    const imp = facts.map((f) => f.importance);
    const mean = imp.reduce((a, b) => a + b, 0) / imp.length;
    const variance = imp.reduce((a, b) => a + (b - mean) ** 2, 0) / imp.length;
    return [mean, Math.sqrt(variance), facts.length];
  };
}

/** 信念「自体」采样器：3 维向量（重要性均值/离散度/记忆负载），维度须与信念引擎一致（默认 3）。 */
function beliefObservationOf(port: LongTermMemoryPort): () => readonly number[] {
  return () => {
    const facts = port.all();
    const imp = facts.map((f) => f.importance);
    const mean = imp.length ? imp.reduce((a, b) => a + b, 0) / imp.length : 0;
    const variance = imp.length ? imp.reduce((a, b) => a + (b - mean) ** 2, 0) / imp.length : 0;
    return [mean, Math.sqrt(variance), Math.min(1, facts.length / 64)];
  };
}
