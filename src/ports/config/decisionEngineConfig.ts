/**
 * （Laya 战略线）决策引擎配置：本地 System-1 推理（`choice` / `score` / `noul`）替代 LLM 长推理
 * 做高频判断点。
 *
 * 默认口径与 `selfVerify` 同模式：**库级默认 `off`**（不装配即零行为，单测 / 嵌入方不受影响）；
 * **生产入口（CLI）默认 `shadow`**（跑、记、不改行为——覆盖「默认关丢覆盖面」这条路）。
 *
 * 全程 fail-open：后端不可用 / 超时 / 调用失败只降级为 `available:false`，不阻断主流程
 * （决策引擎是质量信号，不是安全边界）。
 */
export interface DecisionEngineConfig {
  /** 生效模式：off / shadow / enforce（库级缺省 off；CLI 生产入口缺省 shadow）。 */
  readonly mode: 'off' | 'shadow' | 'enforce';
  /** 选用的 checkpoint repo（缺省 convaiinnovations/laya；有本地权重目录时仅作标识）。 */
  readonly repo?: string | undefined;
  /** Python 解释器路径。缺省解析链：`LAYA_PYTHON_BIN` → 项目内 `third-party/laya-venv` → `python3`。 */
  readonly pythonPath?: string | undefined;
  /** 本地权重目录。缺省解析链：`LAYA_MODEL_DIR` → 项目内 `third-party/laya-model` → 空（走在线 Router）。 */
  readonly modelDir?: string | undefined;
  /** 是否复用常驻热进程（默认 true）。关掉即每次决策单起一次性子进程：不占常驻内存，但单次 18–62s。 */
  readonly warm?: boolean | undefined;
  /** 单发路径单次决策上限（毫秒，默认 120000）；热路径另有更短预算，避免拖住回合。 */
  readonly timeoutMs?: number | undefined;
  /** 是否落盘决策 trace（append-only JSONL，供 RLCD 温度校准 / 借鉴清单训练）。默认 true（仅当 mode≠off 时生效）。 */
  readonly trace?: boolean | undefined;
}
