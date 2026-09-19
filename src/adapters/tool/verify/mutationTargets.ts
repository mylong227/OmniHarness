/**
 * 变更目标解析（纯逻辑）：从一次工具调用的实参里问出「这次到底改了哪些文件 / 写了什么内容」。
 *
 * 存在的理由（2026-09-19 能力盘点，`_audit_tmp/selfverify_probe.mjs` 硬证）：
 * 自验证回环的触发器原先只读 `args.path`，而 `apply_patch` 的 `path` 官方描述就是**可省略**
 * （缺省取 `+++` 头）——于是**不带 path 的 apply_patch 一次都不会触发自验证**
 * （探针实测 `runnerCalls +0`），属于本仓最高频缺陷形态「声明未接线」的又一例。
 * 假完成探测同样只认 `content`，对 `apply_patch` / `edit` 恒为静默跳过——同一根因。
 *
 * 本类把「目标路径」与「新增内容」两个问题的答案收敛到一处，
 * 让装饰器不再依赖「调用方恰好按某种写法传参」。
 */
import { PatchApplier } from '../fs/patchApplier.js';

/** 会改动工作区文件的工具（与 `core/toolGate.ts` 的 `MUTATING_TOOLS` 语义不同：此处只含落盘工具）。 */
export class MutationTargets {
  /** 落盘类工具名集合。 */
  public static readonly WRITE_TOOLS: ReadonlySet<string> = new Set([
    'write_file',
    'edit',
    'apply_patch',
  ]);

  /**
   * 解析本次调用会改动的目标路径（去重、保持出现顺序）。
   *
   * @param toolName 工具名。
   * @param args 工具实参。
   * @returns 目标相对路径列表；非落盘工具或无法解析时为空数组（调用方据此判「没改东西」）。
   */
  public static of(toolName: string, args: Readonly<Record<string, unknown>>): readonly string[] {
    if (!MutationTargets.WRITE_TOOLS.has(toolName)) {
      return [];
    }
    if (toolName !== 'apply_patch') {
      return MutationTargets.explicitPath(args);
    }
    return MutationTargets.unique([
      ...MutationTargets.explicitPath(args),
      ...MutationTargets.patchTargets(args),
    ]);
  }

  /**
   * 解析本次调用**新增/写入的文本**（供假完成探测扫描未完成标记）。
   *
   * @param toolName 工具名。
   * @param args 工具实参。
   * @returns 供探测的文本；无内容可探（如 shell 类）时为 undefined。
   */
  public static addedText(
    toolName: string,
    args: Readonly<Record<string, unknown>>,
  ): string | undefined {
    if (toolName === 'write_file') {
      return MutationTargets.textOf(args['content']);
    }
    if (toolName === 'edit') {
      return MutationTargets.textOf(args['new_string']);
    }
    if (toolName === 'apply_patch') {
      return MutationTargets.patchAddedLines(args);
    }
    return undefined;
  }

  /**
   * 取显式 `path` 实参。
   *
   * @param args 工具实参。
   * @returns 单个路径的列表；`path` 缺失或为空时为等长空数组。
   */
  private static explicitPath(args: Readonly<Record<string, unknown>>): readonly string[] {
    const raw = args['path'];
    return typeof raw === 'string' && raw !== '' ? [raw] : [];
  }

  /**
   * 从补丁文本里取出全部目标文件（多文件补丁会得到多个）。
   *
   * @param args 工具实参（读取 `patch`）。
   * @returns 目标路径列表；补丁缺失或不可解析时为空数组。
   */
  private static patchTargets(args: Readonly<Record<string, unknown>>): readonly string[] {
    const patch = MutationTargets.textOf(args['patch']);
    if (patch === undefined) {
      return [];
    }
    const parsed = new PatchApplier().parseFiles(patch);
    if (!parsed.ok) {
      return [];
    }
    return parsed.files.map((file) => file.targetFile).filter((target) => target !== '');
  }

  /**
   * 从补丁文本里取出新增行文本（`+` 行），供未完成标记扫描。
   *
   * @param args 工具实参（读取 `patch`）。
   * @returns 新增行拼接文本；无新增行时为 undefined。
   */
  private static patchAddedLines(args: Readonly<Record<string, unknown>>): string | undefined {
    const patch = MutationTargets.textOf(args['patch']);
    if (patch === undefined) {
      return undefined;
    }
    const added = patch
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.slice(1));
    return added.length > 0 ? added.join('\n') : undefined;
  }

  /**
   * 取字符串实参（非字符串一律视为缺失）。
   *
   * @param value 原始实参值。
   * @returns 字符串值；类型不符时为 undefined。
   */
  private static textOf(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }

  /**
   * 去重并保持首次出现顺序。
   *
   * @param values 原始列表。
   * @returns 去重后的只读列表。
   */
  private static unique(values: readonly string[]): readonly string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
      if (value === '' || seen.has(value)) {
        continue;
      }
      seen.add(value);
      out.push(value);
    }
    return out;
  }
}
