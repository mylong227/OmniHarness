// SWE-bench 官方 Verified 子集接入（B1 官方跑分的真实接线，替代此前板中不实表述）。
//
// 定位：把报告 #20 的 P3 诚实缺口（"OmniHarness 尚未跑 SWE-bench，能力分数维度暂无
// apples-to-apples 对照"）对接到**官方 500 题 Verified 子集**，而非仅自研 10 题代理套件。
//
// 本模块只负责：① 加载并校验官方 Verified JSON（fail-closed）；② 定义执行器端口
// （LocalDocker / Modal）把"模型补丁 → 官方 harness 判定 resolved"这一环真正跑起来；
// ③ 聚合官方报告。模型补丁（predictions）由调用方注入（我们的 live agent 在用户侧生成）。
//
// 铁律：
//   - 零运行时依赖（仅 node: 内置）；fail-closed——resolved 只认官方 harness 判定，绝不臆造通过。
//   - 缺 docker / modal / cloud token / 官方数据集时**明确报错并返回未通过**，绝不静默假绿。
//   - 官方 500 题 Verified 执行须隔离环境（docker 或 Modal 云执行 gVisor）；本沙箱无 docker/Modal，
//     故本模块为 code-ready + turnkey，执行须在你侧具备相应设施的环境运行。

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ParallelMap } from '../util/parallelMap.js';

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
}

/** 单实例执行结果。 */
export interface VerifiedResult {
  /** 实例 id。 */
  readonly id: string;
  /** 官方 harness 是否判定 resolved（FAIL_TO_PASS 全过 且 PASS_TO_PASS 全过）。 */
  readonly resolved: boolean;
  /** 执行后端。 */
  readonly backend: 'docker' | 'modal';
  /** 未通过原因（resolved 时缺省）。 */
  readonly reason?: string | undefined;
}

/** 官方 Verified 套件汇总报告。 */
export interface VerifiedReport {
  /** 来源数据集路径。 */
  readonly source: string;
  /** 执行后端。 */
  readonly backend: 'docker' | 'modal';
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
 * 执行器端口：把"给定模型补丁 → 官方 harness 判定 resolved"这一环真正跑起来。
 * 具体后端（docker / Modal）实现须保证 fail-closed：任何异常都返回 resolved=false 并写明原因。
 */
export interface ExecutorPort {
  /** 后端种类。 */
  readonly kind: 'docker' | 'modal';
  /**
   * 运行单实例：应用给定模型补丁，交由官方 harness 判定 resolved。
   * @param instanceId 实例 id。
   * @param modelPatch 模型生成的补丁（unified diff）。
   * @returns 单实例结果（fail-closed，异常即 resolved=false）。
   */
  run(instanceId: string, modelPatch: string): Promise<VerifiedResult>;
}

/** 执行器共享配置。 */
export interface ExecutorOptions {
  /** 模型名（用于预测文件 model_name_or_path 与输出路径）。 */
  readonly modelName: string;
  /** 模型 API base（透传给上游 harness 调我们的 agent）。 */
  readonly modelApiBase: string;
  /** 模型 API key（透传给上游 harness 调我们的 agent）。 */
  readonly modelApiKey: string;
  /** 官方 swe_bench_tasks.json 路径（含每实例环境/安装信息，harness 必需）。 */
  readonly tasksJsonPath: string;
}

/**
 * B1 官方 SWE-bench Verified 子集接入（C7 收口：纯函数/编排迁入静态方法）。
 */
export class SwebenchVerified {
  /**
   * 校验某命令是否可用（fail-closed 前置检查）。
   * @param cmd 命令名（如 docker / modal / python3）。
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
   * 异步执行命令（Promise 封装，供执行器 shell-out 到上游 harness）。
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
   * @param jsonPath 官方 swe_bench_verified.json 路径。
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
   * 有界均衡并行——官方 500 题逐个 docker/Modal 实例**相互独立**，串行是主要墙钟瓶颈，
   * 并发后墙钟趋近 `总工作量 / N`。结果**严格同序**（与 tasks 下标一一对应）。
   * 注：并发度须与后端承载能力匹配（本地 docker 受内存/端口限制；Modal 云执行可更大）。
   *
   * @param tasks 归一化任务列表。
   * @param predictions 实例 id → 模型补丁 映射（由调用方注入，如我们的 live agent 产出）。
   * @param executor 执行器（docker / modal）。
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
        return executor.run(task.id, patch);
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

  /**
   * 从上游 harness 产出的 report 目录解析单实例 resolved（容忍多版本形态，fail-closed）。
   * @param outDir 上游 harness 输出目录（含 report.json）。
   * @param instanceId 实例 id。
   * @returns 解析到的 resolved（找不到报告/实例即 null，由调用方判定未通过）。
   */
  public static parseResolved(outDir: string, instanceId: string): boolean | null {
    if (!existsSync(outDir)) return null;
    let reportPath: string | undefined;
    for (const name of readdirSync(outDir)) {
      if (name === 'report.json' || name.endsWith('report.json')) {
        reportPath = join(outDir, name);
        break;
      }
    }
    if (reportPath === undefined) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(reportPath, 'utf8')) as unknown;
    } catch {
      return null;
    }
    if (parsed !== null && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const hit = obj[instanceId];
      if (hit !== undefined && hit !== null && typeof hit === 'object') {
        const r = (hit as { resolved?: unknown }).resolved;
        if (typeof r === 'boolean') return r;
      }
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (
            item !== null &&
            typeof item === 'object' &&
            (item as { instance_id?: unknown }).instance_id === instanceId
          ) {
            const r = (item as { resolved?: unknown }).resolved;
            if (typeof r === 'boolean') return r;
          }
        }
      }
    }
    return null;
  }
}

/**
 * 本地 docker 执行器：经上游 `swebench` harness 在本地容器跑单实例（fail-closed）。
 * 需要本机 docker + python + swebench 包 + 官方 tasks JSON；缺设施即返回 resolved=false 并写明原因。
 */
export class LocalDockerExecutor implements ExecutorPort {
  /** 后端种类标识（固定 docker）。 */
  public readonly kind = 'docker' as const;

  /**
   * 构造本地 docker 执行器。
   * @param opts 执行器配置（模型名/base/key + 官方 tasks JSON 路径）。
   */
  public constructor(private readonly opts: Readonly<ExecutorOptions>) {}

  /** @returns 无；仅暴露构造配置（便于调试）。 */
  public describe(): string {
    return `docker(model=${this.opts.modelName}, tasks=${this.opts.tasksJsonPath})`;
  }

  /**
   * 运行单实例：检查 docker/python/tasks 设施后调上游 harness 判定 resolved（fail-closed）。
   * @param instanceId 实例 id。
   * @param modelPatch 模型生成的补丁（unified diff）。
   * @returns 单实例结果（缺设施即 resolved=false 并写明原因）。
   */
  public async run(instanceId: string, modelPatch: string): Promise<VerifiedResult> {
    if (!SwebenchVerified.commandAvailable('docker')) {
      return this.fail(instanceId, 'docker 不可用（LocalDockerExecutor 需要本机 docker）');
    }
    if (
      !SwebenchVerified.commandAvailable('python3') &&
      !SwebenchVerified.commandAvailable('python')
    ) {
      return this.fail(instanceId, 'python 不可用（上游 swebench harness 需要 python）');
    }
    if (!existsSync(this.opts.tasksJsonPath)) {
      return this.fail(instanceId, `官方 tasks JSON 不存在: ${this.opts.tasksJsonPath}`);
    }
    return this.invoke(instanceId, modelPatch, false);
  }

  /**
   * 构造上游 harness 调用并解析 resolved（fail-closed）。
   * @param instanceId 实例 id。
   * @param modelPatch 模型补丁。
   * @param useModal 是否加 --modal。
   * @returns 单实例结果。
   */
  private async invoke(
    instanceId: string,
    modelPatch: string,
    useModal: boolean,
  ): Promise<VerifiedResult> {
    const work = mkdtempSync(join(tmpdir(), 'omni-verified-'));
    try {
      const predsPath = join(work, 'predictions.jsonl');
      const modelName = `omni-${this.opts.modelName}`;
      writeFileSync(
        predsPath,
        `${JSON.stringify({ instance_id: instanceId, model_name_or_path: modelName, model_patch: modelPatch })}\n`,
        'utf8',
      );
      const runId = `omni-${this.opts.modelName}-${instanceId}`;
      const args = [
        '-m',
        'swebench.harness.run_evaluation',
        '--predictions_path',
        predsPath,
        '--swe_bench_tasks',
        this.opts.tasksJsonPath,
        '--dataset_name',
        'princeton-nlp/SWE-bench_Verified',
        '--split',
        'test',
        '--namespace',
        'omni',
        '--run_id',
        runId,
        '--instance_ids',
        instanceId,
      ];
      if (useModal) args.push('--modal');
      const python = SwebenchVerified.commandAvailable('python3') ? 'python3' : 'python';
      await SwebenchVerified.execFileAsync(python, args, work);
      const resolved = SwebenchVerified.parseResolved(
        join(work, 'run_evaluation_results', runId),
        instanceId,
      );
      if (resolved === null) {
        return this.fail(
          instanceId,
          '上游 harness 未产出可解析的 report（resolved 未知，按未通过）',
        );
      }
      return { id: instanceId, resolved, backend: this.kind };
    } catch (error) {
      return this.fail(
        instanceId,
        `上游 harness 执行异常: ${String((error as { message?: string })?.message ?? error)}`,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  /**
   * 构造未通过结果。
   * @param instanceId 实例 id。
   * @param reason 原因。
   * @returns 未通过结果。
   */
  private fail(instanceId: string, reason: string): VerifiedResult {
    return { id: instanceId, resolved: false, backend: 'docker', reason };
  }
}

/**
 * Modal 云执行器：经上游 `swebench` harness 的 `--modal` 在 Modal 云（gVisor 隔离）跑单实例（fail-closed）。
 * 零本地 docker；需要 `modal` CLI + `MODAL_TOKEN` + python + swebench 包 + 官方 tasks JSON。
 */
export class ModalExecutor implements ExecutorPort {
  /** 后端种类标识（固定 modal）。 */
  public readonly kind = 'modal' as const;

  /**
   * 构造 Modal 执行器。
   * @param opts 执行器配置（模型名/base/key + 官方 tasks JSON 路径）。
   */
  public constructor(private readonly opts: Readonly<ExecutorOptions>) {}

  /** @returns 无；仅暴露构造配置（便于调试）。 */
  public describe(): string {
    return `modal(model=${this.opts.modelName}, tasks=${this.opts.tasksJsonPath})`;
  }

  /**
   * 运行单实例：检查 modal CLI/MODAL_TOKEN/python/tasks 设施后调上游 harness（--modal）判定 resolved（fail-closed）。
   * @param instanceId 实例 id。
   * @param modelPatch 模型生成的补丁（unified diff）。
   * @returns 单实例结果（缺设施即 resolved=false 并写明原因）。
   */
  public async run(instanceId: string, modelPatch: string): Promise<VerifiedResult> {
    if (!SwebenchVerified.commandAvailable('modal')) {
      return this.fail(
        instanceId,
        'modal CLI 不可用（ModalExecutor 需要 `pip install modal` 并登录）',
      );
    }
    if (process.env.MODAL_TOKEN === undefined || process.env.MODAL_TOKEN.length === 0) {
      return this.fail(instanceId, 'MODAL_TOKEN 未设置（Modal 云执行需要 cloud 凭证）');
    }
    if (
      !SwebenchVerified.commandAvailable('python3') &&
      !SwebenchVerified.commandAvailable('python')
    ) {
      return this.fail(instanceId, 'python 不可用（上游 swebench harness 需要 python）');
    }
    if (!existsSync(this.opts.tasksJsonPath)) {
      return this.fail(instanceId, `官方 tasks JSON 不存在: ${this.opts.tasksJsonPath}`);
    }
    return this.invoke(instanceId, modelPatch, true);
  }

  /**
   * 构造上游 harness 调用并解析 resolved（fail-closed）。详见 LocalDockerExecutor.invoke。
   * @param instanceId 实例 id。
   * @param modelPatch 模型补丁。
   * @param useModal 是否加 --modal（本类恒 true）。
   * @returns 单实例结果。
   */
  private async invoke(
    instanceId: string,
    modelPatch: string,
    useModal: boolean,
  ): Promise<VerifiedResult> {
    const work = mkdtempSync(join(tmpdir(), 'omni-verified-'));
    try {
      const predsPath = join(work, 'predictions.jsonl');
      const modelName = `omni-${this.opts.modelName}`;
      writeFileSync(
        predsPath,
        `${JSON.stringify({ instance_id: instanceId, model_name_or_path: modelName, model_patch: modelPatch })}\n`,
        'utf8',
      );
      const runId = `omni-${this.opts.modelName}-${instanceId}`;
      const args = [
        '-m',
        'swebench.harness.run_evaluation',
        '--predictions_path',
        predsPath,
        '--swe_bench_tasks',
        this.opts.tasksJsonPath,
        '--dataset_name',
        'princeton-nlp/SWE-bench_Verified',
        '--split',
        'test',
        '--namespace',
        'omni',
        '--run_id',
        runId,
        '--instance_ids',
        instanceId,
        '--modal',
      ];
      void useModal;
      const python = SwebenchVerified.commandAvailable('python3') ? 'python3' : 'python';
      await SwebenchVerified.execFileAsync(python, args, work);
      const resolved = SwebenchVerified.parseResolved(
        join(work, 'run_evaluation_results', runId),
        instanceId,
      );
      if (resolved === null) {
        return this.fail(
          instanceId,
          '上游 harness 未产出可解析的 report（resolved 未知，按未通过）',
        );
      }
      return { id: instanceId, resolved, backend: this.kind };
    } catch (error) {
      return this.fail(
        instanceId,
        `上游 harness 执行异常: ${String((error as { message?: string })?.message ?? error)}`,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  /**
   * 构造未通过结果。
   * @param instanceId 实例 id。
   * @param reason 原因。
   * @returns 未通过结果。
   */
  private fail(instanceId: string, reason: string): VerifiedResult {
    return { id: instanceId, resolved: false, backend: 'modal', reason };
  }
}
