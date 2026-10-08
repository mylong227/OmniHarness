/**
 * Laya 运行时路径解析：解释器 / 权重目录 / 项目根（**零配置可用**的唯一实现）。
 *
 * ## 为什么独立成文件
 *
 * 适配器主类负责「推理编排」，路径解析是另一件事——而它正是本仓最典型的缺陷形态
 * 「声明未接线」的现场：`THIRD_PARTY_ASSETS.md` 宣称「适配器默认 `LAYA_PYTHON_BIN` 指向
 * `third-party/laya-venv/Scripts/python.exe`」，而代码里**从来没读过**这个变量、默认值恒为
 * 系统 `python3`（本机 = Python 3.14.8，无 laya/torch/transformers）⇒ 1.7GB 的 venv + 权重
 * 在运行时零调用，且因为全程 fail-open 而无任何告警。把解析收进一处后，解析顺序可被单测逐条锁死。
 *
 * ## 解析顺序（两条路径同构：显式 → 环境变量 → 项目内 → 兜底）
 *
 * | 项     | 显式参数                  | 环境变量          | 项目内                                         | 兜底                |
 * | ------ | ------------------------- | ----------------- | ---------------------------------------------- | ------------------- |
 * | 解释器 | `decisionEngine.pythonPath` | `LAYA_PYTHON_BIN` | `third-party/laya-venv/Scripts/python.exe`    | `python3`           |
 * | 权重   | `decisionEngine.modelDir`   | `LAYA_MODEL_DIR`  | `third-party/laya-model`                      | 空（走在线 Router） |
 *
 * 项目内路径只在**真的存在**时才被采用（不存在即回落兜底，不指向缺失路径硬失败）。
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 解释器环境变量名（覆盖项目内 venv 默认；与上游 `laya` 文档口径一致）。 */
const PYTHON_ENV_KEY = 'LAYA_PYTHON_BIN';

/** 权重目录环境变量名。 */
const MODEL_ENV_KEY = 'LAYA_MODEL_DIR';

/** 项目内第三方总管目录名。 */
const THIRD_PARTY_DIR = 'third-party';

/** 项目内 Laya 运行时 venv 目录名。 */
const VENV_DIR = 'laya-venv';

/** 项目内 Laya 权重目录名。 */
const MODEL_DIR = 'laya-model';

/**
 * 兜底解释器（PATH 上的 `python` / `python3`）。
 *
 * Windows 上优先猜 `python`：python.org 安装器、conda 与多数发行版提供的是 `python.exe`，
 * `python3.exe` 主要出现在 Microsoft Store 别名上（2026-10-07 评审发现：写死 `python3` 会让
 * 「Windows + 官方安装器」这一最常见组合在兜底档上直接失败）。
 */
const FALLBACK_PYTHON = process.platform === 'win32' ? 'python' : 'python3';

/** 项目根标志文件（命中任一即认为是仓库根）。 */
const ROOT_MARKERS: readonly string[] = ['package.json', 'omniharness.json'];

/**
 * Laya 路径解析器（无状态；全部静态方法，便于在适配器与测试里共用同一份判据）。
 */
export class LayaPaths {
  /**
   * 从起始目录向上找项目根（含 `package.json` / `omniharness.json` 的最近祖先）。
   *
   * @param from 起始目录（通常为适配器所在目录）。
   * @returns 项目根绝对路径；一路到盘根都没找到时返回空串。
   */
  public static projectRoot(from: string): string {
    let dir = from;
    for (;;) {
      if (ROOT_MARKERS.some((marker) => existsSync(join(dir, marker)))) {
        return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        return '';
      }
      dir = parent;
    }
  }

  /**
   * 项目内 venv 的解释器路径（按平台布局；**不检查是否存在**）。
   *
   * @param root 项目根。
   * @returns Windows `Scripts/python.exe`；其它平台 `bin/python`。
   */
  public static venvPython(root: string): string {
    return process.platform === 'win32'
      ? join(root, THIRD_PARTY_DIR, VENV_DIR, 'Scripts', 'python.exe')
      : join(root, THIRD_PARTY_DIR, VENV_DIR, 'bin', 'python');
  }

  /**
   * 项目内权重目录路径（**不检查是否存在**）。
   *
   * @param root 项目根。
   * @returns `third-party/laya-model` 绝对路径。
   */
  public static projectModelDir(root: string): string {
    return join(root, THIRD_PARTY_DIR, MODEL_DIR);
  }

  /**
   * 解析 Python 解释器：显式参数 → `LAYA_PYTHON_BIN` → 项目内 venv → 平台兜底名
   * （Windows `python` / 其它 `python3`）。
   *
   * @param from 起始目录（用于定位项目根）。
   * @param explicit 显式配置的解释器（空串视为未配置）。
   * @returns 解释器路径；项目内 venv 不存在时返回平台兜底名。
   */
  public static pythonPath(from: string, explicit?: string | undefined): string {
    if (explicit !== undefined && explicit.length > 0) {
      return explicit;
    }
    const fromEnv = process.env[PYTHON_ENV_KEY];
    if (fromEnv !== undefined && fromEnv.length > 0) {
      return fromEnv;
    }
    const root = LayaPaths.projectRoot(from);
    if (root.length > 0) {
      const candidate = LayaPaths.venvPython(root);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    return FALLBACK_PYTHON;
  }

  /**
   * 解析权重目录：显式参数 → `LAYA_MODEL_DIR` → 项目内 `third-party/laya-model` → 空串。
   *
   * @param from 起始目录（用于定位项目根）。
   * @param explicit 显式配置的权重目录（空串视为未配置）。
   * @returns 权重目录绝对路径；项目内不存在时返回空串（调用方转走在线 Router）。
   */
  public static modelDir(from: string, explicit?: string | undefined): string {
    if (explicit !== undefined && explicit.length > 0) {
      return explicit;
    }
    const fromEnv = process.env[MODEL_ENV_KEY];
    if (fromEnv !== undefined && fromEnv.length > 0) {
      return fromEnv;
    }
    const root = LayaPaths.projectRoot(from);
    if (root.length === 0) {
      return '';
    }
    const candidate = LayaPaths.projectModelDir(root);
    return existsSync(candidate) ? candidate : '';
  }
}
