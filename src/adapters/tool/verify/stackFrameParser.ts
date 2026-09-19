/**
 * 失败输出的**堆栈帧定位**提取（P1-⑩）。
 *
 * 为什么需要它：`TestFailureDigest` 只抽「失败行」，模型拿到的是
 * `AssertionError: expected 1 to equal 2`（Python）或 `not ok 3 - 用例名`（node --test），
 * 但**不知道自己该去改哪个文件的哪一行** —— 于是还得再翻一遍源码。
 * 本类把输出里的堆栈帧归一化为 `文件:行` 候选清单，直接附在回灌摘要后。
 *
 * 覆盖形态（纯正则、零依赖）：
 * - Node / Jest / Vitest：`at fn (src/a.ts:12:34)`、`at src/a.ts:12:34`
 * - Python traceback：`  File "/app/x.py", line 12, in test_x`
 * - pytest 单行：`x.py:12: AssertionError`
 * - Go：`\t/app/x.go:12 +0x1f`
 * - Rust：`--> src/main.rs:12:5`
 * - Java：`at com.Foo.bar(Foo.java:12)`
 *
 * **共同噪声一律剔除**：`node:internal/**`、`node_modules/**`、`<anonymous>`——
 * 它们是运行时/依赖的帧，不是模型该改的地方；混进来只会稀释信号。
 */

/** 单次最多返回的定位候选数（防一个深栈把摘要刷满）。 */
const DEFAULT_MAX_LOCATIONS = 8;

/** 纯噪声前缀（运行时内部帧 / 依赖帧），命中即丢弃。 */
const NOISE = /^(?:node:internal|node:|<anonymous>|internal\/|.*[\\/]node_modules[\\/])/;

/** 各语言栈帧里「路径:行[:列]」的出现形态（按优先级排列）。 */
const FRAME_PATTERNS: readonly RegExp[] = [
  // Python 回溯：File "/app/x.py", line 12, in test_x
  /^\s*File\s+"([^"]+)",\s*line\s+(\d+)/,
  // Rust：--> src/main.rs:12:5
  /-->+\s*([^\s:]+):(\d+)(?::\d+)?/,
  // Node / Jest / Vitest：at fn (src/a.ts:12:34) 或 at src/a.ts:12:34
  /\bat\s+(?:[^\s(]+\s+\()?([^\s():]+):(\d+)(?::\d+)?\)?/,
  // Java：at com.Foo.bar(Foo.java:12)
  /\bat\s+[\w.$<>]+\(([^():]+):(\d+)\)/,
  // Go：/app/x.go:12 +0x1f（行首为制表符）
  /^\s*([^\s:]+\.go):(\d+)/,
  // pytest 单行：x.py:12: AssertionError
  /^\s*([^\s:]+\.(?:py|ts|tsx|js|jsx|mjs|cjs|rs|go|java|rb|c|cc|cpp|h|hpp)):(\d+):/,
];

/**
 * 堆栈帧定位提取器（无状态，纯静态）。
 */
export class StackFrameParser {
  /**
   * 从原始输出里抽出 `文件:行` 候选（保持出现顺序、去重、限量）。
   *
   * `相对路径` 原样返回（模型看到的就是仓库内路径，可直接交给 read_file / edit）；
   * 需要绝对路径时由调用方自行拼接（本类刻意不做路径解析，保持纯函数）。
   *
   * @param raw 原始输出（stdout + stderr 合并）。
   * @param max 最多返回条数（≤0 时取 1）。
   * @returns `文件:行` 候选清单；一条都没解析到时返回空数组。
   */
  public static locate(raw: string, max: number = DEFAULT_MAX_LOCATIONS): readonly string[] {
    const limit = max > 0 ? max : 1;
    const found: string[] = [];
    const seen = new Set<string>();
    for (const line of raw.split('\n')) {
      const frame = StackFrameParser.frameOf(line);
      if (frame === undefined || seen.has(frame)) {
        continue;
      }
      seen.add(frame);
      found.push(frame);
      if (found.length >= limit) {
        break;
      }
    }
    return found;
  }

  /**
   * 把单行匹配为 `文件:行`（按 {@link FRAME_PATTERNS} 顺序取首个命中）。
   *
   * @param line 原始行（未归一化）。
   * @returns `文件:行` 文本；未命中、命中噪声帧或路径不像文件时返回 `undefined`。
   */
  private static frameOf(line: string): string | undefined {
    const clean = line.replace(/\u001b\[[0-9;]*m/g, '').replace(/\r$/, '');
    for (const pattern of FRAME_PATTERNS) {
      const hit = pattern.exec(clean);
      if (hit === null) {
        continue;
      }
      const rawFile = hit[1];
      const rawLine = hit[2];
      if (rawFile === undefined || rawLine === undefined) {
        continue;
      }
      const file = StackFrameParser.normalize(rawFile);
      if (file === undefined) {
        continue;
      }
      return `${file}:${rawLine}`;
    }
    return undefined;
  }

  /**
   * 归一化路径并做噪声剔除。
   *
   * @param file 正则捕获到的原始路径片段。
   * @returns 归一化后的路径（正斜杠）；属噪声或明显非文件时返回 `undefined`。
   */
  private static normalize(file: string): string | undefined {
    const trimmed = file.trim().replace(/^\(/, '').replace(/^\.\//, '');
    if (trimmed === '' || NOISE.test(trimmed)) {
      return undefined;
    }
    // 必须看起来像个文件（含扩展名），否则多为表达式片段（如 `new Promise`）。
    if (!/\.[A-Za-z0-9]{1,5}$/.test(trimmed)) {
      return undefined;
    }
    return trimmed.split('\\').join('/');
  }
}
