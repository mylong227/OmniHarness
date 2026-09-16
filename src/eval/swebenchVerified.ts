// SWE-bench 官方 Verified 子集接入（B1 官方跑分的真实接线，免 Docker、免云）。
//
// 定位：把报告 #20 的 P3 诚实缺口对接到**官方 500 题 Verified 子集**。本模块只负责：
// ① 加载并校验官方 Verified JSON（fail-closed）；② 定义执行器端口（NativeExecutor）把
// "模型补丁 → pytest 判定 resolved"这一环真正本地跑起来；③ 聚合官方报告。
// 模型补丁（predictions）由调用方注入（我们的 live agent 在你侧生成）。
//
// 铁律：
//   - 零运行时依赖（仅 node: 内置）；fail-closed——resolved 只认 pytest 判定，绝不臆造通过。
//   - 缺 git / uv / 网络（克隆或 pip）时**明确报错并返回未通过**，绝不静默假绿。
//   - 原生执行不等同官方 Docker 镜像（env 由 repo 自述 + uv 重建）；用于本地迭代/自测，
//     官方 apples-to-apples 分数建议官方 harness。本模块为 code-ready + turnkey。
//
// 与现代 swebench（≥5.x）的契约：环境/安装元数据经 `--dataset_name` 自动从 HuggingFace 加载；
// 本地 `swe_bench_tasks.json` 文件与 `--swe_bench_tasks`/`--namespace` 旗标**已废弃**。原生执行器
// 不走上游 harness（`--modal`/docker），而是直接在本地用 uv + pytest 复现，故无需该契约文件。

import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ParallelMap } from '../util/parallelMap.js';

/** 官方 Verified 数据集默认 HF id（仅文档/对照引用，原生执行不强制拉取）。 */
export const DEFAULT_VERIFIED_DATASET = 'princeton-nlp/SWE-bench_Verified';

/** 官方 Verified 原始实例（仅取我们消费的字段）。 */
export interface VerifiedInstance {
  /** 官方实例 id（如 django__django-12345）。 */
  readonly instance_id: string;
  /** 仓库 slug（如 django/django）。 */
  readonly repo: string;
  /** base commit（checkout 基准）。 */
  readonly base_commit: string;
  /** gold patch（unified diff）。 */
  readonly patch: string;
  /** 测试补丁（FAIL_TO_PASS / PASS_TO_PASS 测试）。 */
  readonly test_patch: string;
  /** 须由修复使其通过的测试（字符串列表）。 */
  readonly FAIL_TO_PASS: readonly string[];
  /** 须保持通过的回归测试（字符串列表）。 */
  readonly PASS_TO_PASS: readonly string[];
  /** 版本标签。 */
  readonly version: string;
  /** 问题陈述（喂给 agent 的修复指令）。 */
  readonly problem_statement: string;
}

/** 归一化后的官方 Verified 任务（本模块内部使用，字段已拍平）。 */
export interface VerifiedTask {
  /** 实例 id。 */
  readonly id: string;
  /** 仓库 slug。 */
  readonly repo: string;
  /** base commit。 */
  readonly baseCommit: string;
  /** 问题陈述。 */
  readonly problemStatement: string;
  /** gold patch（仅校验/对照用，不参与评分）。 */
  readonly goldPatch: string;
  /** 测试补丁。 */
  readonly testPatch: string;
  /** FAIL_TO_PASS 测试。 */
  readonly failToPass: readonly string[];
  /** PASS_TO_PASS 测试。 */
  readonly passToPass: readonly string[];
  /** 版本标签（驱动 Python 版本选择；缺省空串回落默认）。 */
  readonly version: string;
}

/** 单实例执行结果。 */
export interface VerifiedResult {
  /** 实例 id。 */
  readonly id: string;
  /** 官方 harness 是否判定 resolved（FAIL_TO_PASS 全过 且 PASS_TO_PASS 全过）。 */
  readonly resolved: boolean;
  /** 执行后端（恒 native）。 */
  readonly backend: 'native';
  /** 未通过原因（resolved 时缺省）。 */
  readonly reason?: string | undefined;
}

/** 官方 Verified 套件汇总报告。 */
export interface VerifiedReport {
  /** 来源数据集路径。 */
  readonly source: string;
  /** 执行后端（恒 native）。 */
  readonly backend: 'native';
  /** 解析到的实例总数。 */
  readonly total: number;
  /** 已 resolved 数。 */
  readonly resolved: number;
  /** 失败（含未提供预测/执行异常）数。 */
  readonly failed: number;
  /** 逐实例结果。 */
  readonly results: readonly VerifiedResult[];
  /** 总耗时（ms）。 */
  readonly totalDurationMs: number;
}

/**
 * 执行器端口：把"给定模型补丁 → pytest 判定 resolved"这一环真正本地跑起来。
 * 具体后端（当前仅 {@link NativeExecutor}）必须保证 fail-closed：任何异常都返回 resolved=false 并写明原因。
 */
export interface ExecutorPort {
  /** 后端种类（恒 native）。 */
  readonly kind: 'native';
  /**
   * 运行单实例：应用给定模型补丁，交由 pytest 判定 resolved。
   * @param task 归一化任务（含 repo/base_commit/version/测试清单）。
   * @param modelPatch 模型生成的补丁（unified diff）。
   * @returns 单实例结果（fail-closed，异常即 resolved=false）。
   */
  run(task: VerifiedTask, modelPatch: string): Promise<VerifiedResult>;
}

/** 官方 Verified 套件汇总报告聚合（C7 收口：纯函数/编排迁入静态方法）。 */
export class SwebenchVerified {
  /**
   * 校验某命令是否可用（fail-closed 前置检查）。
   * @param cmd 命令名（如 git / uv / python3）。
   * @returns 可用返回 true；否则 false。
   */
  public static commandAvailable(cmd: string): boolean {
    try {
      execFileSync(cmd, ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 异步执行命令（Promise 封装，供执行器 shell-out 到 git/uv/pytest）。
   * @param cmd 命令。
   * @param args 参数。
   * @param cwd 工作目录。
   * @returns 标准输出文本。
   */
  public static execFileAsync(cmd: string, args: readonly string[], cwd: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        if (err !== null) {
          reject(err);
        } else {
          resolve(stdout);
        }
      });
    });
  }

  /**
   * 加载并校验官方 Verified JSON（fail-closed）。
   * @param jsonPath 官方 swe_bench_verified.json 路径（HF 数据集转出的实例数组）。
   * @returns 归一化任务列表。
   */
  public static loadVerified(jsonPath: string): VerifiedTask[] {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(jsonPath, 'utf8')) as unknown;
    } catch (error) {
      throw new Error(
        `官方 Verified 数据集读取/解析失败: ${String((error as { message?: string })?.message ?? error)}`,
      );
    }
    if (!Array.isArray(raw)) {
      throw new Error('官方 Verified 数据集根节点须为数组（instance 列表）');
    }
    const tasks: VerifiedTask[] = [];
    raw.forEach((entry, index) => {
      const inst = entry as Partial<VerifiedInstance>;
      const missing = SwebenchVerified.requireFields(inst);
      if (missing.length > 0) {
        throw new Error(
          `官方 Verified 实例 #${index} 缺字段: ${missing.join(', ')}（数据集形态不符，拒绝静默加载）`,
        );
      }
      tasks.push({
        id: inst.instance_id as string,
        repo: inst.repo as string,
        baseCommit: inst.base_commit as string,
        problemStatement: inst.problem_statement as string,
        goldPatch: inst.patch as string,
        testPatch: inst.test_patch as string,
        failToPass: (inst.FAIL_TO_PASS as readonly string[]) ?? [],
        passToPass: (inst.PASS_TO_PASS as readonly string[]) ?? [],
        version: (inst.version as string | undefined) ?? '',
      });
    });
    return tasks;
  }

  /**
   * 校验官方实例必填字段，返回缺失项。
   * @param inst 待校验实例。
   * @returns 缺失字段名列表（空表示齐全）。
   */
  private static requireFields(inst: Partial<VerifiedInstance>): readonly string[] {
    const required: readonly (keyof VerifiedInstance)[] = [
      'instance_id',
      'repo',
      'base_commit',
      'patch',
      'test_patch',
      'FAIL_TO_PASS',
      'PASS_TO_PASS',
      'problem_statement',
    ];
    return required.filter((k) => {
      const v = inst[k];
      return v === undefined || v === null || (typeof v === 'string' && v.length === 0);
    });
  }

  /**
   * 跑整套官方 Verified：逐实例取预测补丁 → 执行器判定 → 聚合。
   *
   * 并发：默认 `concurrency = 1`（严格串行，与旧行为一致）；N>1 时走 {@link ParallelMap}
   * 有界均衡并行——官方 500 题逐个实例**相互独立**，串行是主要墙钟瓶颈，并发后墙钟趋近 `总工作量 / N`。
   * 结果**严格同序**（与 tasks 下标一一对应）。注：并发度须与后端承载能力匹配（原生执行受
   * 网络/磁盘/同仓库 worktree 串行约束；跨仓库可更大并发）。
   *
   * @param tasks 归一化任务列表。
   * @param predictions 实例 id → 模型补丁 映射（由调用方注入，如我们的 live agent 产出）。
   * @param executor 执行器（native）。
   * @param concurrency 并发上限（默认 1=串行）。
   * @returns 汇总报告。
   */
  public static async runVerifiedSuite(
    tasks: readonly VerifiedTask[],
    predictions: ReadonlyMap<string, string>,
    executor: ExecutorPort,
    concurrency = 1,
  ): Promise<VerifiedReport> {
    const t0 = Date.now();
    const runner = new ParallelMap(concurrency);
    const results: readonly VerifiedResult[] = await runner.map(
      tasks,
      async (task): Promise<VerifiedResult> => {
        const patch = predictions.get(task.id);
        if (patch === undefined) {
          return {
            id: task.id,
            resolved: false,
            backend: executor.kind,
            reason: '未提供模型预测（predictions 缺该 instance_id）',
          };
        }
        return executor.run(task, patch);
      },
    );
    const resolved = results.filter((r) => r.resolved).length;
    return {
      source: 'official-swebench-verified',
      backend: executor.kind,
      total: tasks.length,
      resolved,
      failed: tasks.length - resolved,
      results,
      totalDurationMs: Date.now() - t0,
    };
  }

  /**
   * 人类可读的官方 Verified 报告。
   * @param report 汇总报告。
   * @returns 多行文本。
   */
  public static formatVerifiedReport(report: VerifiedReport): string {
    const lines: string[] = [];
    lines.push(`=== SWE-bench 官方 Verified (backend=${report.backend}) ===`);
    for (const r of report.results) {
      const mark = r.resolved ? '✅' : '❌';
      lines.push(`${mark} ${r.id}${r.resolved ? '' : `  - ${r.reason ?? '未通过'}`}`);
    }
    const rate = report.total === 0 ? 0 : (report.resolved / report.total) * 100;
    lines.push(
      `--- 汇总: ${report.resolved}/${report.total} resolved (${rate.toFixed(1)}%), 失败 ${report.failed}, 总耗时 ${report.totalDurationMs}ms ---`,
    );
    return lines.join('\n');
  }
}
