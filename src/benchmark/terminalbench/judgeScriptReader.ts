/**
 * 判分脚手架读取器：从 `run-tests.sh` 里抽出**判分依赖**与**判分入口**。
 *
 * 上游每个任务的 `run-tests.sh` 都是同一份模板：先 `apt-get install curl`、
 * 再 `curl … astral.sh/uv/install.sh | sh` 装 uv、`uv venv .tbench-testing`、
 * `uv pip install pytest==… <任务依赖>`，最后一行
 * `uv run pytest $TEST_DIR/test_outputs.py -rA`。
 *
 * 前几步是**容器内的自助装包**（装 curl/uv 只是为了让容器里有个 python 工具链），
 * 原生执行不需要重复它们：`uv` 由宿主提供，venv 由本适配器统一创建。
 * 真正需要保留的信息只有两条：
 *  - **判分要装哪些包**（`uv pip install` 那一行，各任务不同，必须读）；
 *  - **判分入口是不是 pytest**（决定能不能用原生 pytest 判分器）。
 *
 * 所以这里只做「抽取」不做「复现」——复现脚手架那几步在无容器环境里毫无意义，
 * 且会让每次判分都去联网装 curl。
 */
import { existsSync, readFileSync } from 'node:fs';

/** `run-tests.sh` 的抽取结果。 */
export interface JudgeScriptSpec {
  /** 判分所需的 Python 包（含 `pytest`；从 `uv pip install` / `pip install` 行取出）。 */
  readonly packages: readonly string[];
  /** 是否声明了 pytest 判分入口。 */
  readonly usesPytest: boolean;
  /** 安装方式是否要求落到「系统环境」（`--system`）。 */
  readonly systemInstall: boolean;
  /** 判分脚本是否引用了 `$TEST_DIR`（决定测试目录注入方式）。 */
  readonly usesTestDir: boolean;
}

/** 判分脚手架读取器（纯静态工具类，无可变状态）。 */
export class JudgeScriptReader {
  private constructor() {}

  /**
   * 读取并抽取 `run-tests.sh`。
   *
   * @param path 脚本路径。
   * @returns 抽取结果；文件不存在时返回「空规格」。
   */
  public static read(path: string): JudgeScriptSpec {
    if (!existsSync(path)) {
      return JudgeScriptReader.empty();
    }
    return JudgeScriptReader.parse(readFileSync(path, 'utf8'));
  }

  /**
   * 抽取脚本文本。
   *
   * @param text 脚本原文。
   * @returns 抽取结果。
   */
  public static parse(text: string): JudgeScriptSpec {
    const packages: string[] = [];
    let usesPytest = false;
    let systemInstall = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) {
        continue;
      }
      if (/\bpytest\b/.test(line)) {
        usesPytest = true;
      }
      const m = /^(?:sudo\s+)?(?:uv\s+pip|pip3?|python3?\s+-m\s+pip)\s+install\s+(.*)$/.exec(line);
      if (m === null) {
        continue;
      }
      const tokens = m[1]!.split(/\s+/).filter((t) => t !== '');
      if (tokens.includes('--system')) {
        systemInstall = true;
      }
      for (const token of tokens) {
        if (token.startsWith('-')) {
          continue;
        }
        // 去掉版本约束留包名会让「装什么版本」失真，故整串保留。
        if (!packages.includes(token)) {
          packages.push(token);
        }
      }
    }
    return {
      packages,
      usesPytest,
      systemInstall,
      usesTestDir: /\$TEST_DIR|\$\{TEST_DIR\}/.test(text),
    };
  }

  /**
   * 空规格（脚本缺失时的占位）。
   *
   * @returns 不含任何声明的规格。
   */
  public static empty(): JudgeScriptSpec {
    return { packages: [], usesPytest: false, systemInstall: false, usesTestDir: false };
  }
}
