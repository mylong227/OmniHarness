import { RepoMapContextEngine } from './repoMapContextEngine.js';

/**
 * repo-map 引擎的进程级提供者（唯一实例持有者）。
 *
 * ## 为什么必须有它（2026-10-03 实测缺陷）
 *
 * `RepoMapContextEngine` 的**全部价值都在进程内长寿命缓存**上：`CorpusIndexCache`
 * （全仓语料索引，本仓 902 文件实测 8.6s 量级）、`SemanticIndexCache`（嵌入向量索引）、
 * `RepoMapMemo`（结果单槽位）。此前装配层在**每个组合根**里 `new RepoMapContextEngine()`：
 *
 *  - `config/memoryStackAssembler`：**每次** `ConfigFactory.build` 一个新实例；
 *  - `subagent/subagentRuntimeFactory`：**每个子代理**一个新实例。
 *
 * 于是缓存生命期 = 一次装配的生命期，而不是进程的生命期：每次构建配置（CLI 每次 `--help`
 * 之外的任何装配、服务端每次新建会话、每个子代理）都重新索引一遍全仓。实测两个后果：
 *  ① `tests/unit/sessionLifecycle.test.ts` 6 个用例共 **100s**（每例 ~16.7s，其中两遍全仓索引），
 *     逼近 120s 文件级超时 ⇒ 并发全量跑法下该文件被 cancelled，官方门禁 `npm test` **exit 1**；
 *  ② 生产侧「起一个子代理 = 多付一次 8.6s + 一份全仓语料内存」，子代理越多越贵。
 *
 * 共享一个实例后，缓存生命期回到进程级（与 `CorpusIndexCache` 文档声明的
 * 「**进程级复用**」一致），上述两项成本一次性消失。
 *
 * ## 一致性（为什么共享是安全的）
 *
 * 引擎内部三块缓存都有**同一性判据**，不依赖实例边界：
 *  - 语料：`CorpusIndexCache` 按 root + 内容签名（TTL 仅作兜底复核节流）；
 *  - 语义索引：`SemanticIndexCache` 键含语料实例身份（`WeakMap` 单调 id）；
 *  - 结果 memo：`RepoMapMemo` 命中要求**同一语料实例**。
 *
 * 故共享实例不会把 A 会话的陈旧结果喂给 B 会话：语料变了 ⇒ 新语料实例 ⇒ 下游全部 miss 重建。
 * {@link RepoMapContextEngine.clear}（硬清）从任一调用点触发都是**全局保守**方向——多清一次只会
 * 让后续查询重建，不会让任何调用点读到陈旧语料。
 *
 * ## 与 SINGLETON_REGISTRY 的关系
 *
 * 本类是「实例类 + 组合根单例」范式的组合根侧持有者，**不引入模块级 `new`**
 * （`audit:metrics` 的模块级 new 清单不受影响），已登记于 `docs/archive/SINGLETON_REGISTRY.md`。
 */
export class RepoMapEngineProvider {
  /** 进程级共享引擎（懒构造：首次取用时创建，此后恒同实例）。 */
  private static shared: RepoMapContextEngine | undefined;

  /**
   * 取进程级共享的 repo-map 引擎。
   * @returns 本进程唯一的 `RepoMapContextEngine` 实例。
   */
  public static engine(): RepoMapContextEngine {
    RepoMapEngineProvider.shared ??= new RepoMapContextEngine();
    return RepoMapEngineProvider.shared;
  }

  /**
   * 丢弃当前共享实例（下次 {@link RepoMapEngineProvider.engine} 重建）。
   *
   * 存在的唯一理由是**测试隔离**：需要「全新引擎 = 全新空缓存」的用例可显式重置，
   * 而不必依赖进程未被复用。生产路径不应调用（调用即丢弃全部缓存，下一次查询
   * 全量重建，代价 8.6s 量级）。
   * @returns 无返回值。
   */
  public static reset(): void {
    RepoMapEngineProvider.shared = undefined;
  }
}
