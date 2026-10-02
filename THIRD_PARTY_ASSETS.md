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
- `third-party/laya-venv/` 为 laya 运行时的 Python venv（torch 2.14+cpu + transformers 5.17 + huggingface_hub 1.33 + laya 0.3.21）。**不入库**（gitignore，机器相关 + 大体积）；重建：`python -m venv third-party/laya-venv` 后 `pip install torch==2.14.0 --index-url https://download.pytorch.org/whl/cpu transformers==5.17 huggingface_hub==1.33 laya==0.3.21`。适配器默认 `LAYA_PYTHON_BIN` 指向 `third-party/laya-venv/Scripts/python.exe`、`LAYA_MODEL_DIR` 指向 `third-party/laya-model`（均可用环境变量覆盖）。

## 第三方目录按功能划分（2026-10-02 盘点收编）

此前评测脚本与生产装配把模型/向量/仓库缓存放任在**仓库之外**（硬编码 `D:/deepseek/.omni-*`
或 HF 家目录），换机即失效且位置不可预测。现按功能统一收编进 `third-party/<功能>/`
（全部 gitignored，可随时重建；重建方式即首次使用时的自动下载/克隆）：

| 目录                          | 功能                                         | 谁写入 / 谁读取                                                                          | 重建 / 覆盖方式                                                     |
| ----------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `third-party/laya/`           | laya Python 包源码快照（入库）               | 人工存档                                                                                 | 按 upstream 自取                                                    |
| `third-party/laya-model/`     | laya 决策引擎权重                            | laya 适配器读取                                                                          | hf-mirror 手动拉取（见上）                                          |
| `third-party/laya-venv/`      | laya 运行时 Python venv                      | laya 适配器（`LAYA_PYTHON_BIN`）                                                         | `python -m venv` + pip（见上）                                      |
| `third-party/model-cache/`    | 嵌入模型 ONNX 权重缓存（e5/minilm/gte/jina） | `@huggingface/transformers`（生产 `configFactory.buildEmbeddingPort` 缺省 + evals 缺省） | 自动从 HF/hf-mirror 下载；`OMNI_EMBEDDING_CACHE_DIR` 可指回任意位置 |
| `third-party/vec-cache/`      | 语义检索向量缓存                             | evals `CachedEmbeddingPort`（`OMNI_VEC_CACHE` 可覆盖）                                   | 随评测自动重建                                                      |
| `third-party/swebench-repos/` | SWE-bench 评测仓库 git 克隆缓存              | evals `NativeExecutor`（`repoCacheRoot`）                                                | 随评测自动克隆                                                      |

The root Apache-2.0 license applies to OmniHarness code. It does not relicense
third-party images, model weights, node packages, or benchmark material.
Upstream licenses and included notices continue to apply. No model weights
or executable ComfyUI custom-node packages are bundled; names in workflow
JSON files identify dependencies.

## Evaluation Provenance

The six `scripts/evaluate_*.py` files target the benchmark protocols listed in
[BENCHMARKS.md](BENCHMARKS.md) and record upstream implementation URLs in their
summaries. KRIS-Bench rubric text is retained in
`scripts/kris_official_prompts.py` with its upstream attribution. Benchmark
annotations and generated result media remain outside version control.
