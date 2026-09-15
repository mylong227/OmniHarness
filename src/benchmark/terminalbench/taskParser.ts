/**
 * Terminal-Bench 任务目录解析器（B2）。
 *
 * 职责：读取任务目录下的 task.yaml，产出结构化 {@link TerminalBenchTask}。
 * 采用 tolerant 的扁平 YAML 读取（Terminal-Bench task.yaml 为简单键值 + 列表），
 * 缺必填字段即 fail-closed 抛错，避免静默产出半截任务。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TerminalBenchTask } from './types.js';

/** Terminal-Bench 任务解析器（纯静态工具类，无可变状态）。 */
export class TaskParser {
  private constructor() {}

  /**
   * 解析单个任务目录。
   *
   * @param taskDir 任务目录绝对/相对路径（须含 task.yaml 与 run-tests.sh）
   * @returns 结构化任务元信息
   * @throws 当缺少 task.yaml / run-tests.sh 或必填字段缺失时
   */
  public static parse(taskDir: string): TerminalBenchTask {
    const yamlPath = join(taskDir, 'task.yaml');
    if (!existsSync(yamlPath)) {
      throw new Error(`Terminal-Bench 任务缺少 task.yaml: ${yamlPath}`);
    }
    const raw = readFileSync(yamlPath, 'utf8');
    const fields = TaskParser.parseFlatYaml(raw);
    const name = TaskParser.require(fields, 'name');
    const author = TaskParser.require(fields, 'author');
    const difficulty = TaskParser.require(fields, 'difficulty');
    const categories = TaskParser.parseList(fields['categories']);
    const testScript = join(taskDir, 'run-tests.sh');
    if (!existsSync(testScript)) {
      throw new Error(`Terminal-Bench 任务缺少 run-tests.sh: ${testScript}`);
    }
    const setupScript = existsSync(join(taskDir, 'setup.sh')) ? join(taskDir, 'setup.sh') : null;
    return {
      name,
      author,
      difficulty,
      categories,
      dockerImage: fields['docker_image'] ?? null,
      taskDir,
      solutionScript: join(taskDir, 'solution.sh'),
      testScript,
      setupScript,
    };
  }

  /**
   * Tolerant 扁平 YAML 解析：支持 `key: value` 与 `key:` 后跟 `- item` 列表。
   *
   * @param raw task.yaml 原始文本
   * @returns 扁平字段表（列表值以换行连接）
   */
  private static parseFlatYaml(raw: string): Record<string, string> {
    const out: Record<string, string> = {};
    const lines = raw.split(/\r?\n/);
    let pendingKey: string | null = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) {
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
    return out;
  }

  /**
   * 读取必填字段。
   *
   * @param fields 扁平字段表
   * @param key 字段名
   * @returns 字段值
   * @throws 当字段缺失或为空时
   */
  private static require(fields: Record<string, string>, key: string): string {
    const value = fields[key];
    if (value === undefined || value.length === 0) {
      throw new Error(`task.yaml 缺少必填字段: ${key}`);
    }
    return value;
  }

  /**
   * 把换行连接的列表值拆回数组。
   *
   * @param value 扁平字段表中可能为列表的值
   * @returns 分类数组（空则空数组）
   */
  private static parseList(value: string | undefined): readonly string[] {
    if (value === undefined || value.length === 0) {
      return [];
    }
    return value
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
}
