/**
 * 资产隔离档（ADR-0009 · EVOLVIX_SPEC §6 信任-隔离矩阵的横轴）。
 *
 * 四档执行位置，从进程内到 OS 沙箱，**同样只能收紧不能放宽**（与 {@link TrustTier} 同纪律）：
 * - `in-process`：直接在主进程内跑（只给 `core` 档用）；
 * - `vm`：`node:vm`（**best-effort**，如实标注——它不是安全边界，Wave C 仍是这个口径）；
 * - `wasm`：**内置 wasm 运行时**（Node `WebAssembly` + Worker 硬超时；实现见 `BuiltinWasmRunner`）。
 *   **诚实差别**：V8 不暴露 fuel 计量，故预算是**墙钟超时**而非指令级 fuel——同一模块在不同机器上
 *   "能跑完的指令数"会不同。该差别写在实现模块注释里，不在口径上含糊；日后准入 wasmtime 可原地替换。
 * - `os-sandbox`：既有 policy/restricted/landlock 等 OS 级后端。
 *
 * 「档位不可达 ⇒ **拒绝执行**，不静默降档」（`IsolationPort.run` 的失败语义，Wave C 落地）：
 * 本文件只声明档位与全序，执行语义属 Wave C。
 */
export type IsolationLevel = 'in-process' | 'vm' | 'wasm' | 'os-sandbox';

/**
 * 隔离档全序（下标越大越严；越严越安全，故补丁只允许**增大**下标）。
 *
 * 注意与信任档的区别：信任档是「谁签的字」，隔离档是「跑在哪」；两者独立演进
 * （`core` + `os-sandbox` 是合法组合：出厂资产仍可强制进 OS 沙箱）。
 */
export const ISOLATION_LEVEL_ORDER: readonly IsolationLevel[] = [
  'in-process',
  'vm',
  'wasm',
  'os-sandbox',
];
