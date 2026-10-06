#!/usr/bin/env node
/**
 * 探针共用的**严格命令行解析器**（`_` 前缀 = 共享模块，不是探针，故不在 README 清单内）。
 *
 * ## 回答什么问题
 *
 * 「探针读到的旋钮，真的是用户传进来的那个吗？」——2026-10-06 实测事故：7 号探针的 `arg()`
 * 被补丁打坏成 `startsWith()`（漏传参数 ⇒ 永不匹配），`--chunks=1 / --rerank=1 / --json`
 * **全部静默失效**，两次"变体实测"跑的其实是默认配置；相邻 3 号探针还有**第二形态**：
 * 位置参数 `[K]` 与任何旗标同现即 `Number('--pool') = NaN`，探针照常打印一份"全 0%"报表
 * 并**退出码 0**（已实测复现）。
 *
 * 两个形态的共同点是**仪器说谎**：读数看起来是结论，其实是调用错误。故本模块把三类形态
 * 全部变成**当场退出码 2**（fail-closed）：
 *
 *  1. **未知旗标**（含拼错的名字、单横线形式）；
 *  2. **值旗标的空格形式**（`--pool 400`）——文档曾这么写而实现只认 `--pool=400`，
 *     于是旋钮静默取默认值；此处直接拒绝并给出正确写法；
 *  3. **多余的位置参数**（本探针不接受，或超出声明个数）。
 *
 * 并**随行回显生效旋钮**（`生效旋钮：…`）：这是区分「旗标没生效」与「旋钮无效果」的唯一手段，
 * 也是「判读前核对三件套（表头 / 自检 / JSON）」里最容易被跳过的一件。
 *
 * ## 前置
 *
 * 无。本模块只读 `process.argv`，**不 import 任何编译产物**——故它能排在探针的
 * `dist/**` 动态 import **之前**，使「旗标写错」在缺编译产物时也能当场报错（而不是被
 * "缺少编译产物"的提示盖住）。
 *
 * ## 用法
 *
 * ```js
 * import { probeArgs } from './_args.mjs';
 * const a = probeArgs(
 *   { values: { fileK: '20', json: '' }, flags: { rerank: false } },
 *   { positional: ['K'] },
 * );
 * // a.fileK / a.json / a.rerank / a.K 可用；a.K 未给时为 undefined（由调用方给默认值并校验）
 * ```
 *
 * 保留旗标 `--list-knobs`：只打印本探针认识的旋钮名（JSON 数组）并以 0 退出——
 * 供 `tests/unit/probesInRepo.test.ts` 把「文档里的用法」与「代码真正认识的旋钮」做交叉核对，
 * 从而让"文档写了、代码不认"这种漂移自己变红。
 *
 * ## 诚实边界
 *
 * - 只做**形式**校验（名字 / 写法 / 个数），**不校验取值语义**（如 `--fileK=abc`）——
 *   取值域由各探针自己 fail-closed 校验（见 `semanticHybridRecall.mjs` 的 `Number.isFinite` 一例）；
 * - `--name=` （空值）是合法的：`--json=` 的语义是"不落盘"，与"没传"等价由调用方定义；
 * - 回显只覆盖**本模块解析到的**旋钮；探针若还读环境变量或其他来源，需自行补进回显。
 */

/**
 * 参数错误一律以退出码 2 终止（与探针「缺编译产物」同码，均属**用法/前置**类失败）。
 * @param {string} message 人类可读的原因（应包含**正确写法**）。
 * @returns {never} 本函数不返回。
 */
function die(message) {
  console.error(`✗ 探针参数错误：${message}`);
  process.exit(2);
}

/**
 * 严格解析探针命令行参数。
 * @param {{ values?: Record<string, string>, flags?: Record<string, boolean> }} spec
 *   认识的旋钮：`values` = 值旗标（`--name=value`）；`flags` = 开关（`--name` 或 `--name=1/0`）。
 * @param {{ positional?: readonly string[] }} [opts] 位置参数名（按顺序），缺省不接受位置参数。
 * @returns {Record<string, string | boolean | undefined>} 解析结果（键 = 旋钮名；位置参数未给时为 undefined）。
 */
export function probeArgs(spec, opts = {}) {
  const values = spec.values ?? {};
  const flags = spec.flags ?? {};
  const positionals = opts.positional ?? [];
  /** @type {Record<string, string | boolean | undefined>} */
  const out = { ...values };
  for (const [name, dflt] of Object.entries(flags)) out[name] = dflt;
  /** @type {string[]} */
  const rest = [];
  const knownNames = [...Object.keys(values), ...Object.keys(flags)];

  for (const token of process.argv.slice(2)) {
    if (token === '--list-knobs') {
      process.stdout.write(`${JSON.stringify([...knownNames, ...positionals])}\n`);
      process.exit(0);
    }
    if (!token.startsWith('--')) {
      if (token.startsWith('-') && token.length > 1) {
        die(`未知旗标 ${token}（本探针只用 --name=value 与 --name 两种形式）`);
      }
      rest.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    const raw = eq === -1 ? undefined : token.slice(eq + 1);
    if (Object.hasOwn(flags, name)) {
      if (raw === undefined || raw === '1' || raw === 'true') {
        out[name] = true;
        continue;
      }
      if (raw === '0' || raw === 'false') {
        out[name] = false;
        continue;
      }
      die(`--${name} 是开关，只接受 --${name} / --${name}=1 / --${name}=0（收到 "${raw}"）`);
    }
    if (Object.hasOwn(values, name)) {
      if (raw === undefined) {
        die(
          `--${name} 是值旗标，必须写成 --${name}=<值>；` +
            `空格形式（--${name} <值>）会**静默失效**（历史上真的发生过），故此处直接拒绝`,
        );
      }
      out[name] = raw;
      continue;
    }
    die(
      `未知旗标 ${token}；本探针认识：${knownNames.map((n) => `--${n}`).join(' / ')}` +
        `${positionals.length > 0 ? `，另有位置参数 ${positionals.join(' ')}` : ''}`,
    );
  }

  if (rest.length > positionals.length) {
    const extra = rest.slice(positionals.length).join(' ');
    die(
      positionals.length === 0
        ? `多余的位置参数：${extra}（本探针只接受 --name=value 旗标）`
        : `多余的位置参数：${extra}（本探针只接受 ${String(positionals.length)} 个位置参数：${positionals.join(' ')}）`,
    );
  }
  positionals.forEach((name, index) => {
    out[name] = rest[index];
  });

  const shown = [
    ...positionals.map((n) => `${n}=${out[n] === undefined ? '（未给，用默认）' : String(out[n])}`),
    ...Object.keys(values).map(
      (n) => `${n}=${(out[n] ?? '') === '' ? '（未设）' : String(out[n])}`,
    ),
    ...Object.keys(flags).map((n) => `${n}=${out[n] === true ? 'true' : 'false'}`),
  ];
  console.log(`生效旋钮：${shown.join(' ')}`);
  return out;
}
