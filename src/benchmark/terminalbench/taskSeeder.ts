/**
 * 种子文件摆放器：按任务声明把该进应用根的文件放好。
 *
 * 为什么要单独一个类：它是**纯文件摆放**逻辑（读任务目录、写应用目录），
 * 与「起进程、建 venv、映射 `/app`」这些执行动作没有共同状态。
 * 混在执行后端里会让后端变成什么都管的上帝类，也让摆放规则无法单独测。
 *
 * 语义（对齐目录拷贝的常规约定）：
 * - **源是文件** → `to` 是落点路径；`to` 为 `.`/`./`/以 `/` 结尾时，按源文件名落进去。
 * - **源是目录** → 把它的**内容**拷进 `to`（`src/` 里的东西进 `/app/src/`，不再套一层 `src/src/`）。
 * - 未声明 `seeds` 时回落「整个任务目录兜底拷贝」（宽松兜底比漏拷安全）。
 * - harness 自有条目（`task.yaml` / `env.json` / `run-tests.sh` / `solution.*` / `tests/`）
 *   无论哪种形态都不进应用根——它们不是任务产物，混进去会污染 `ls` 类判分。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { TaskSeed } from './taskEnvironmentReader.js';
import { TaskEnvironmentReader } from './taskEnvironmentReader.js';

/** 判分脚本目录名（`<parent>/tests`）。 */
const TESTS_DIR_NAME = 'tests';

/** 种子文件摆放器（纯静态工具类，无可变状态）。 */
export class TaskSeeder {
  /** 不作为种子文件复制进应用目录的 harness 自有条目（两种形态共用同一份）。 */
  public static readonly META_ENTRIES: readonly string[] = [
    'task.yaml',
    TaskEnvironmentReader.ENV_FILE,
    'run-tests.sh',
    'solution.sh',
    'solution.yaml',
    'solution.yml',
    TESTS_DIR_NAME,
  ];

  private constructor() {}

  /**
   * 按声明把种子文件摆进应用目录。
   *
   * @param taskDir 任务目录（只读源）。
   * @param appDir 应用目录（等价 `/app`）。
   * @param seeds 种子规则；空数组表示整目录兜底拷贝。
   * @param warnings 告警收集数组（就地追加）。
   * @returns 无返回值。
   */
  public static seed(
    taskDir: string,
    appDir: string,
    seeds: readonly TaskSeed[],
    warnings: string[],
  ): void {
    if (seeds.length === 0) {
      TaskSeeder.copyBulk(taskDir, appDir);
      return;
    }
    for (const seed of seeds) {
      TaskSeeder.applySeed(taskDir, appDir, seed, warnings);
    }
  }

  /**
   * 复制任务目录里除 harness 自有条目以外的全部条目。
   *
   * @param taskDir 任务目录。
   * @param appDir 应用目录。
   * @returns 无返回值。
   */
  public static copyBulk(taskDir: string, appDir: string): void {
    cpSync(taskDir, appDir, {
      recursive: true,
      force: true,
      filter: (src) => {
        const name = src.split(/[\\/]/).pop() ?? '';
        return !TaskSeeder.META_ENTRIES.includes(name);
      },
    });
  }

  /**
   * 落实一条种子规则。
   *
   * @param taskDir 任务目录。
   * @param appDir 应用目录。
   * @param seed 种子规则。
   * @param warnings 告警收集数组（就地追加）。
   * @returns 无返回值。
   */
  private static applySeed(
    taskDir: string,
    appDir: string,
    seed: TaskSeed,
    warnings: string[],
  ): void {
    const source = join(taskDir, seed.from);
    if (!existsSync(source)) {
      warnings.push(`种子源不存在，已跳过：${seed.from}`);
      return;
    }
    if (statSync(source).isDirectory()) {
      TaskSeeder.copyDirContents(source, TaskSeeder.appTarget(appDir, seed.to));
      return;
    }
    const target = TaskSeeder.appTarget(appDir, seed.to);
    const file = TaskSeeder.isDirTarget(seed.to) ? join(target, basename(source)) : target;
    mkdirSync(dirname(file), { recursive: true });
    cpSync(source, file, { force: true });
  }

  /**
   * 把目录的**内容**拷进目标目录（目标不存在则连同父目录一起建）。
   *
   * @param source 源目录。
   * @param target 目标目录。
   * @returns 无返回值。
   */
  private static copyDirContents(source: string, target: string): void {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source)) {
      if (TaskSeeder.META_ENTRIES.includes(name)) {
        continue;
      }
      cpSync(join(source, name), join(target, name), { recursive: true, force: true });
    }
  }

  /**
   * 把声明里的落点解析成应用根下的绝对路径。
   *
   * @param appDir 应用目录。
   * @param to 声明落点（相对应用根；`.` / 空串表示应用根本身）。
   * @returns 绝对路径。
   */
  private static appTarget(appDir: string, to: string): string {
    const cleaned = to.trim().replace(/^\.\//, '');
    return cleaned === '' || cleaned === '.' ? appDir : join(appDir, cleaned);
  }

  /**
   * 声明落点是否是「目录」（决定文件源是按名落进去还是替换整个路径）。
   *
   * @param to 声明落点。
   * @returns 以 `/` 结尾或为 `.` 时视为目录。
   */
  private static isDirTarget(to: string): boolean {
    const trimmed = to.trim();
    return trimmed === '.' || trimmed === './' || trimmed.endsWith('/');
  }
}
