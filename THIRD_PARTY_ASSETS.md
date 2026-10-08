# Third-party Assets

The repository uses the following resources.

- `resources/source_image_pool_comfybench/` contains source images and
  metadata from ComfyBench. Metadata records upstream paths, task identifiers,
  file sizes, and SHA-256 digests.
- `resources/source_image_pool_gpt/` contains independently generated source
  images for the source-pool isolation setting. Their metadata identifies them
  as generated images and records file sizes and SHA-256 digests.
- `resources/symbolic_policy/` contains author-provided reference workflows and failure
  records. Historical trace paths in these records describe their original
  experiments; they are not required local execution paths. Runtime retrieval
  and export parameterize workflow inputs before reuse.
- `resources/comfyui_node_reference/` 已**移出版本控制**（2026-09-22）：该语料共 3414 个文件 /
  约 20.8 MB，占当时全仓 tracked 文件的 71%，而 `git grep` 实测**零代码消费者**（唯一提及是本文档）。
  它只是参考资料（非可执行 custom-node 代码），执行期节点 schema 由 ComfyUI 的 `/object_info` 提供，
  故不影响任何运行路径。需要时按上游 ComfyUI 节点包自行获取即可；本地副本仍保留在磁盘上（已被 `.gitignore` 忽略）。
  历史上本文档记录的 `licenses.md` 保留要求，在恢复该目录时同样适用。
- `docs/assets/` contains paper figures and project-page media. The root-level
  `assets/` copy (three JPGs byte-identical to `docs/assets/` figures, zero
  consumers) was removed from version control on 2026-09-25 to de-duplicate.
  These directories are not runtime source-image or policy libraries.

- `third-party/laya/` 存档 laya 开源 Python 包（Apache-2.0，上游 github.com/NandhaKishorM/laya，v0.3.21）的**源码快照**与 `licenses/LICENSE` + `METADATA`，仅作溯源 / 离线审查。运行时仍由 `third-party/laya-venv/` 内 pip 安装的 `laya` 提供，不从此目录加载（避免重复维护两份）。
- `third-party/laya-model/` 含本地决策引擎权重（`convaiinnovations/laya` checkpoint：`model.safetensors` 842MB + `rl_agent_config.json` + `tokenizer/` + `encoder/`）。**不入库**（gitignore，仓库政策不 bundled 权重）；离线获取：本机 `huggingface.co` 不可达，统一走 `HF_ENDPOINT=https://hf-mirror.com` 镜像，纯 urllib 直连 `hf-mirror.com/resolve/main/<file>` 手动拉取（小文件普通 GET、大文件带 Range 头触发 206；可断点续传），绕开 huggingface_hub 在本机 Windows 的 safe-delete 死结（Xet CAS 经镜像 401）。
- `third-party/laya-venv/` 为 laya 运行时的 Python venv（torch 2.14+cpu + transformers 5.17 + huggingface_hub 1.33 + laya 0.3.21）。**不入库**（gitignore，机器相关 + 大体积）；重建：`python -m venv third-party/laya-venv` 后 `pip install torch==2.14.0 --index-url https://download.pytorch.org/whl/cpu transformers==5.17 huggingface_hub==1.33 laya==0.3.21`。

  > **2026-10-07 订正（原文曾是错的，留痕以免再犯）**：此处原写「适配器默认 `LAYA_PYTHON_BIN` 指向
  > `third-party/laya-venv/Scripts/python.exe`、`LAYA_MODEL_DIR` 指向 `third-party/laya-model`」——
  > **只有后半句是真的**：适配器从来没有读过 `LAYA_PYTHON_BIN`（`git log -S LAYA_PYTHON_BIN -- src/adapters/laya/` 为空），
  > 解释器默认值恒为系统 `python3`（本机 3.14.8，无 laya/torch/transformers）⇒ `isAvailable()` 恒 false、
  > `decide` 恒 fail-open，**而 fail-open 不写任何告警**。加上 `decisionEngine.mode` 从未被任何配置源打开
  > （配置文件与 CLI 都没有入口），结果是这 1.7GB 的 venv + 权重在真实运行里**零调用**。
  > 现在解释器同样零配置可用，解析顺序（显式 → 环境变量 → 项目内 → 兜底）由
  > `src/adapters/laya/layaPaths.ts` 单点决定，判据在 `tests/unit/layaPaths.test.ts` 与集成测试
  > `tests/integration/layaBackend.test.ts`（它不再要求手工设环境变量）。

## Laya 运行时的实际接线（2026-10-07 实测，供排查）

| 事实         | 值 / 做法                                                                                                                                                                                                                                                                                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 零配置解析链 | 解释器：`decisionEngine.pythonPath` → `LAYA_PYTHON_BIN` → `third-party/laya-venv/Scripts/python.exe` → 平台兜底名（Windows `python` / 其它 `python3`）。**`.bat`/`.cmd` 包装被明确拒绝**（常驻模式靠 stdin 管道送协议帧，`cmd.exe` 经 `shell` 起时不会转发 ⇒ 必然 EOF 退出）；权重：`decisionEngine.modelDir` → `LAYA_MODEL_DIR` → `third-party/laya-model` → 空（走在线 Router） |
| 用户面入口   | `omniharness.json` 的 `decisionEngine` 段（`mode`/`repo`/`pythonPath`/`modelDir`/`warm`/`timeoutMs`/`trace`，严格校验）+ CLI `--decision-engine <mode>` / `--no-decision-engine` / `--decision-engine-python <path>`；**生产入口默认 `shadow`**（跑、记、不改行为），库级默认仍是 `off`                                                                                           |
| 热进程       | 适配器以 `laya_infer.py --serve` 起**常驻**子进程（JSONL over stdio，一次加载多次前向）。实测：端到端探测 0.58–0.71s（冷启 1.65s；探测预算 5s）/ 首次含加载 842MB 权重 **12.7–24s**（视磁盘缓存）/ 其后每次 **0.4–1.3s**；单发路径每次重载 ⇒ 冷启 62.4s、暖盘 18–19s                                                                                                              |
| 冷启动窗口   | 权重未就绪时**决策立即跳过（0 延迟、不排队推理）**，加载继续在后台；就绪后走 `requestTimeoutMs`（默认 15s，与 `timeoutMs` 取较小者）。加载帧另受 `loadTimeoutMs`（默认 3 分钟）约束——**必须有界**，否则「活着但永不回帧」会让加载态永久卡死。跳过落一条 warn；**加载失败**另落一条并如实报原因                                                                                    |
| 探测缓存     | **正结果永久缓存；负结果 60s 过期自动重探**（`availabilityRetryMs`，适配器选项）。理由：一次探测抖动不得把整个进程的 Laya 判死（原实现永久缓存 `false`，连 `warmUp()` 都救不回）                                                                                                                                                                                                  |
| 资源成本     | 常驻进程持有约 2GB 内存（torch 2.14 CPU + 421MB 参数）；空闲 `idleShutdownMs`（默认 10 分钟）自动回收，下次请求重启。空闲时对父进程事件循环**不设引用**（父进程退出即释放，不留孤儿——实测无残留进程）                                                                                                                                                                             |
| 加速/排障    | `--no-decision-engine` 关闭；`warm:false` 走单发（不占常驻内存，代价是每次 18–62s；单发超时经 `execFile` + `SIGKILL` 真正生效）；想立刻要真信号用适配器的 `warmUp(timeoutMs)`（集成测试即用它）                                                                                                                                                                                   |
| 已知后端事实 | 上游 checkpoint 自带部分非法校准温度，`laya` 会在 stderr 告警「treat confidence from the affected entries as uncalibrated」——**noul/score 的置信度在受影响项上未校准**，只可当作序信号用                                                                                                                                                                                          |

## 第三方目录按功能划分（2026-10-02 盘点收编）

此前评测脚本与生产装配把模型/向量/仓库缓存放任在**仓库之外**（硬编码 `D:/deepseek/.omni-*`
或 HF 家目录），换机即失效且位置不可预测。现按功能统一收编进 `third-party/<功能>/`
（全部 gitignored，可随时重建；重建方式即首次使用时的自动下载/克隆）：

| 目录                       | 功能                                         | 谁写入 / 谁读取                                                             | 重建 / 覆盖方式                                                     |
| -------------------------- | -------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `third-party/laya/`        | laya Python 包源码快照（入库）               | 人工存档                                                                    | 按 upstream 自取                                                    |
| `third-party/laya-model/`  | laya 决策引擎权重                            | laya 适配器读取                                                             | hf-mirror 手动拉取（见上）                                          |
| `third-party/laya-venv/`   | laya 运行时 Python venv                      | laya 适配器（零配置探测该路径；`LAYA_PYTHON_BIN` 可覆盖）                   | `python -m venv` + pip（见上）                                      |
| `third-party/model-cache/` | 嵌入模型 ONNX 权重缓存（e5/minilm/gte/jina） | `@huggingface/transformers`（生产 `configFactory.buildEmbeddingPort` 缺省） | 自动从 HF/hf-mirror 下载；`OMNI_EMBEDDING_CACHE_DIR` 可指回任意位置 |
| `third-party/vec-cache/`   | 语义检索向量缓存                             | `DiskCachedEmbeddingAdapter`（`OMNI_VEC_CACHE` 可覆盖，生产语义检索路径）   | 随语义索引构建自动重建                                              |

~~`third-party/swebench-repos/`~~（SWE-bench 评测仓库克隆缓存）：**2026-10-03 随跑分/评测
子系统整体删除**——`eval-data/`、`evals/`、`python/`、`scripts/evaluate_*.py` 与
`scripts/run_*.py` 全部移除，本项目不再产生该类缓存。

The root Apache-2.0 license applies to OmniHarness code. It does not relicense
third-party images, model weights, node packages, or benchmark material.
Upstream licenses and included notices continue to apply. No model weights
or executable ComfyUI custom-node packages are bundled; names in workflow
JSON files identify dependencies.

## Evaluation Provenance

~~The six `scripts/evaluate_*.py` files target the benchmark protocols listed in
[BENCHMARKS.md](BENCHMARKS.md)~~ —— **2026-10-03 已失效**：这六个评测脚本、`BENCHMARKS.md`
与 `scripts/kris_official_prompts.py`（KRIS-Bench 评分细则文本及上游署名）**已随跑分/评测
子系统整体删除**。相关上游署名与许可信息如需追溯，见 git 历史（删除前版本）与
`docs/PROJECT_BOARD.md` §7 的变更登记；**当前仓库不再包含任何对外评测协议实现**。
