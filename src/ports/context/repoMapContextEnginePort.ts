import type { EmbeddingPort } from '../model/embedding.js';
import type { RepoMapContextOptions } from './repoMapContextOptions.js';

/**
 * repo-map 上下文引擎端口（G25 收尾，2026-10-04 第三十轮）。
 *
 * 原 `ResolvedConfig.repoMapContext` / `StepRunnerDeps.repoMapContext` 绑定在 context 层实现类
 * `RepoMapContextEngine` 上——端口契约被绑死在具体类型，构成 ports→context 的隐性实现依赖
 * （门禁 [3.5] 当时只覆盖 core/adapters/config/composition，`context/`/`search/` 是漏网层）。
 * 抽到端口后，`ports/config/**` 与 `core/stepTypes` 仅依赖本接口；实现类
 * `RepoMapContextEngine` `implements` 本接口，实例仍由组合根（`repoMapEngineProvider`）装配。
 *
 * 端口面 = 生产消费方的**全部**外部调用：两路上下文获取（纯 BM25 / 混合）+ 写类工具成功后的
 * 缓存失效（`stepToolExecutor` 的 U4 接线）。实现类上更宽的公共面（cacheStats / clear /
 * buildChunkItems 等）属实现细节，不进契约。
 */
export interface RepoMapContextEnginePort {
  /**
   * 纯 BM25 检索 repo-map 上下文（零开销词法路；任何失败 fail-closed 返回 null）。
   * @param root 工作区根目录。
   * @param q 由最近 user 消息推导的查询文本。
   * @param opts 检索旋钮（缺省 = env / 默认三级解析）。
   * @returns 注入用上下文文本；不可用时 null。
   */
  getRepoMapContext(root: string, q: string, opts?: RepoMapContextOptions): string | null;

  /**
   * 混合检索（BM25 ∪ 语义 RRF）。实现自身 fail-closed，异常不应外溢。
   * @param root 工作区根目录。
   * @param q 查询文本。
   * @param embedding 语义嵌入端口。
   * @param opts 检索旋钮（缺省 = env / 默认三级解析）。
   * @returns 注入用上下文文本；不可用时 null。
   */
  getHybridRepoMapContext(
    root: string,
    q: string,
    embedding: EmbeddingPort,
    opts?: RepoMapContextOptions,
  ): Promise<string | null>;

  /**
   * 失效检索缓存（U4：写类工具成功后按根目录失效，消除 30s TTL 陈旧窗口）。
   * @param root 工作区根目录；缺省 = 全部。
   * @returns 无返回值。
   */
  invalidate(root?: string): void;
}
