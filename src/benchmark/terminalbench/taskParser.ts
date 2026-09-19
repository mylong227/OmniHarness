/**
 * Terminal-Bench 任务目录解析器（B2）。
 *
 * 职责：读取任务目录下的 `task.yaml`，结合 `env.json` 与 `run-tests.sh`，
 * 产出结构化 {@link TerminalBenchTask}。
 *
 * ## 为什么重写（2026-09-19）
 *
 * 原实现是按**假想的 schema** 写的：读 `name` / `author` / `difficulty` / `categories`，
 * 而上游真实字段是 `instruction` / `author_name` / `difficulty` / `category`（单数），
 * 且**任务名在 task.yaml 里根本不存在**（由目录名给出）。
 * 后果是它在真实任务集上**每一题都会抛错**——「本地解析器跑得通」曾被误当作能力就绪，
 * 属于本仓最典型的缺陷形态：**有实现、无接线、对着错的契约**。
 *
 * ## 解析策略
 *
 * - YAML：tolerant 扁平读取（上游 task.yaml 是简单键值 + 列表 + 一个 `|-` 块标量），
 *   支持块标量（`instruction` 正文），不引入 YAML 依赖。
 * - 必填只有 `instruction` 与 `tests/` 目录：缺 `instruction` 无法出题、缺判分用例无法判分，
 *   二者 fail-closed；其余字段缺失一律**回落约定值**并继续（缺个 `tags` 不该让整题作废）。
 * - 环境与判分依赖交给 {@link TaskEnvironmentReader} 与 {@link JudgeScriptReader} 抽取，
 *   本类只负责组装。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { TerminalBenchTask } from './types.js';
import { TaskEnvironmentReader } from './taskEnvironmentReader.js';
import { JudgeScriptReader } from './judgeScriptReader.js';

/** 上游约定值（缺失字段的回落目标）。 */
interface ParseDefaults {
  /** 判分器名。 */
  readonly parserName: string;
  /** Agent 超时（秒）。 */
  readonly agentTimeoutSec: number;
  /** 判分超时（秒）。 */
  readonly testTimeoutSec: number;
}

/** 参考解候选文件名（按优先级）。 */
const SOLUTION_NAMES: readonly string[] = ['solution.sh', 'solution.yaml', 'solution.yml'];

/** Terminal-Bench 任务解析器（纯静态工具类，无可变状态）。 */
export class TaskParser {
  /** 上游缺省判分器。 */
  public static readonly DEFAULT_PARSER = 'pytest';

  /** 上游缺省 Agent 超时（秒）。 */
  public static readonly DEFAULT_AGENT_TIMEOUT_SEC = 900;

  /** 上游缺省判分超时（秒）。 */
  public static readonly DEFAULT_TEST_TIMEOUT_SEC = 180;

  private constructor() {}

  /**
   * 解析单个任务目录。
   *
   * @param taskDir 任务目录绝对/相对路径（须含 task.yaml 与 tests/）。
   * @returns 结构化任务元信息。
   * @throws 当缺少 task.yaml、缺少 instruction、或缺少 tests/ 目录时。
   */
  public static parse(taskDir: string): TerminalBenchTask {
    // 一律解析成绝对路径：这些路径会跨进程使用（bash 在应用目录里跑参考解、判分器切 cwd），
    // 相对路径一旦离开「调用者的当前目录」就会解析成别的地方——表现为「参考解 exit 127 / 找不到脚本」，
    // 于是保真度被记成能力失败，方向恰好相反。
    const rootDir = resolve(taskDir);
    const yamlPath = join(rootDir, 'task.yaml');
    if (!existsSync(yamlPath)) {
      throw new Error(`Terminal-Bench 任务缺少 task.yaml: ${yamlPath}`);
    }
    const fields = TaskParser.parseFlatYaml(readFileSync(yamlPath, 'utf8'));
    const instruction = (fields['instruction'] ?? '').trim();
    if (instruction === '') {
      throw new Error(`task.yaml 缺少必填字段 instruction: ${yamlPath}`);
    }
    const testsDir = join(rootDir, 'tests');
    if (!existsSync(testsDir) || !statSync(testsDir).isDirectory()) {
      throw new Error(`Terminal-Bench 任务缺少 tests/ 目录: ${testsDir}`);
    }
    const testScript = join(rootDir, 'run-tests.sh');
    const solutionScript = TaskParser.firstExisting(rootDir, SOLUTION_NAMES);
    const environment = TaskEnvironmentReader.read(rootDir);
    const judge = JudgeScriptReader.read(testScript);
    const defaults: ParseDefaults = {
      parserName: TaskParser.DEFAULT_PARSER,
      agentTimeoutSec: TaskParser.DEFAULT_AGENT_TIMEOUT_SEC,
      testTimeoutSec: TaskParser.DEFAULT_TEST_TIMEOUT_SEC,
    };
    return {
      name: basename(rootDir),
      instruction,
      authorName: (fields['author_name'] ?? fields['author'] ?? '').trim(),
      difficulty: (fields['difficulty'] ?? 'unknown').trim(),
      category: TaskParser.categoryOf(fields),
      tags: TaskParser.listOf(fields['tags']),
      parserName: (fields['parser_name'] ?? defaults.parserName).trim(),
      maxAgentTimeoutSec: TaskParser.numberOf(
        fields['max_agent_timeout_sec'],
        defaults.agentTimeoutSec,
      ),
      maxTestTimeoutSec: TaskParser.numberOf(
        fields['max_test_timeout_sec'],
        defaults.testTimeoutSec,
      ),
      taskDir: rootDir,
      testScript,
      testsDir,
      solutionScript,
      environment,
      judgePackages: judge.packages,
    };
  }

  /**
   * 主分类：上游为单数 `category`；兼容少数题用的 `categories` 列表（取首个）。
   *
   * @param fields 扁平字段表。
   * @returns 分类名（缺失为空串）。
   */
  private static categoryOf(fields: Record<string, string>): string {
    const single = (fields['category'] ?? '').trim();
    if (single !== '') {
      return single;
    }
    return TaskParser.listOf(fields['categories'])[0] ?? '';
  }

  /**
   * 读取第一个存在的候选文件。
   *
   * @param dir 目录。
   * @param names 候选文件名（按优先级）。
   * @returns 绝对路径；都不存在为 null。
   */
  private static firstExisting(dir: string, names: readonly string[]): string | null {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * Tolerant 扁平 YAML 读取。
   *
   * 支持三件事（够解析上游 task.yaml）：
   * - `key: value`；
   * - `key:` 后跟缩进的 `- item` 列表；
   * - `key: |-` / `|` / `>` 块标量（`instruction` 正文是多行）。
   *
   * @param raw task.yaml 原始文本。
   * @returns 扁平字段表（列表值以换行连接）。
   */
  private static parseFlatYaml(raw: string): Record<string, string> {
    const out: Record<string, string> = {};
    const lines = raw.split(/\r?\n/);
    let pendingKey: string | null = null;
    let blockKey: string | null = null;
    let blockIndent = -1;
    let blockLines: string[] = [];
    const flushBlock = (): void => {
      if (blockKey !== null) {
        out[blockKey] = blockLines.join('\n');
      }
      blockKey = null;
      blockIndent = -1;
      blockLines = [];
    };
    for (const line of lines) {
      const indent = line.length - line.trimStart().length;
      const trimmed = line.trim();
      if (blockKey !== null) {
        if (trimmed === '' || indent > blockIndent) {
          blockLines.push(line.slice(blockIndent + 1).trimEnd());
          continue;
        }
        flushBlock();
      }
      if (trimmed === '' || trimmed.startsWith('#')) {
        continue;
      }
      const listItem = /^-\s+(.*)$/.exec(trimmed);
      if (listItem !== null && pendingKey !== null) {
        const item = listItem[1]!.trim();
        const prev = out[pendingKey];
        out[pendingKey] = prev === undefined || prev.length === 0 ? item : `${prev}\n${item}`;
        continue;
      }
      const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(trimmed);
      if (kv === null) {
        pendingKey = null;
        continue;
      }
      const key = kv[1]!;
      const val = kv[2]!.trim();
      if (TaskParser.isBlockHeader(val)) {
        pendingKey = null;
        blockKey = key;
        blockIndent = indent;
        blockLines = [];
        out[key] = '';
        continue;
      }
      if (val.length === 0) {
        if (!(key in out)) {
          out[key] = '';
        }
        pendingKey = key;
      } else {
        out[key] = val;
        pendingKey = null;
      }
    }
    flushBlock();
    return out;
  }

  /**
   * 是否是 YAML 块标量头（`|` / `|-` / `|+` / `>` / `>-` / `>+`）。
   *
   * @param value 冒号后的取值。
   * @returns 是块标量头则为 true。
   */
  private static isBlockHeader(value: string): boolean {
    return /^[|>][+-]?$/.test(value);
  }

  /**
   * 把换行连接的列表值拆回数组。
   *
   * @param value 扁平字段表中可能为列表的值。
   * @returns 列表（缺失为空数组）。
   */
  private static listOf(value: string | undefined): readonly string[] {
    if (value === undefined || value.length === 0) {
      return [];
    }
    return value
      .split('\n')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter((s) => s.length > 0);
  }

  /**
   * 读数值字段（非法/缺失回落默认）。
   *
   * @param value 原始取值。
   * @param fallback 默认值。
   * @returns 合法数值。
   */
  private static numberOf(value: string | undefined, fallback: number): number {
    if (value === undefined) {
      return fallback;
    }
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
}
