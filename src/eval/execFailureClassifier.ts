/**
 * 判分执行失败的**归类器**（从 `NativeExecutor` 的主链路 catch 缝抽出）。
 *
 * 为什么单列一个类：判分可信度要求「执行设施层异常」与「模型没解出」**严格分流**——
 * 前者不含模型能力信息，必须可单独重试且不进 `resolved` 分母。这条分流规则此前写死在
 * `NativeExecutor` 的 catch 里，既让它继续长（已逼近上帝类代码行阈值），也无法被独立证伪。
 * 抽成纯函数式判定后可零依赖单测（`tests/unit/execFailureClassifier.test.ts`）。
 *
 * 两类设施层异常（实测现场）：
 *  1. {@link ENV_BUILD_FAILED} 前缀——仓库/pytest 未装入 venv，该实例根本没进入 pytest 判定；
 *  2. `spawn <系统错误码>`（`spawn ENAMETOOLONG` / `EPERM` / `ENOENT`…）——进程创建本身就失败。
 *     2026-09-26 实测：django-10097 把十万字符级 test id 灌进 argv ⇒ `spawn ENAMETOOLONG`，
 *     旧实现落进通用 catch 被记成**模型失败**（与早前 spawn EPERM 事故同类错分）。
 */

import { ENV_BUILD_FAILED } from './nativeEnvBuilder.js';

/** 失败归属：`env` = 执行设施层（可重试、不进分母）；`model` = 模型侧未解出。 */
export type ExecFailureKind = 'env' | 'model';

/** 归类结果：归属 + 归一化后的可读原因（直接写入判分结果）。 */
export interface ExecFailureVerdict {
  /** 失败归属。 */
  readonly kind: ExecFailureKind;
  /** 写入判分结果的原因文本。 */
  readonly message: string;
}

/**
 * spawn 系统错误形态：Node 在 `child_process` 失败时给出的 `error.message` 以 `spawn ` 开头，
 * 后接大写错误码（`spawn ENAMETOOLONG`）。用**锚定**匹配避免把普通文案里的 "spawn" 误判为设施故障。
 */
const SPAWN_SYSTEM_ERROR = /^spawn [A-Z]+\b/;

/**
 * 判分执行失败归类器（无状态、纯函数，可安全并发复用）。
 */
export class ExecFailureClassifier {
  /**
   * 归类一条执行异常消息。
   * @param msg 归一化后的异常消息（`NativeExecutor.msg` 的产物）。
   * @returns 归属与写入判分结果的原因文本。
   */
  public classify(msg: string): ExecFailureVerdict {
    if (msg.startsWith(ENV_BUILD_FAILED)) {
      return { kind: 'env', message: msg };
    }
    if (SPAWN_SYSTEM_ERROR.test(msg)) {
      return { kind: 'env', message: `原生执行设施异常: ${msg}` };
    }
    return { kind: 'model', message: `原生执行异常: ${msg}` };
  }
}

/** 组合根门面：默认实例（无状态，共享安全）。 */
export const execFailureClassifier = new ExecFailureClassifier();
