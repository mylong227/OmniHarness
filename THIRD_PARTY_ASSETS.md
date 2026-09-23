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
- `assets/` and `docs/assets/` contain paper figures and project-page media.
  These directories are not runtime source-image or policy libraries.

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
