import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EventPort } from '../ports/eventPort.js';
import type { ToolPort } from '../ports/tool.js';
import type { ResolvedConfig } from '../config/configFactory.js';
import type { OmniHarnessRuntime } from '../core/runtime.js';
import type { StoragePort } from '../ports/storage.js';
import { Container } from '../core/container.js';
import { ServiceKeys } from '../core/runtime.js';
import { ToolGate } from '../core/toolGate.js';
import type { SubagentPorts } from './subagentPorts.js';
import { ToolDiscovery } from '../search/toolDiscovery.js';
import { Bm25MemoryIndex } from '../adapters/retrieval/bm25MemoryIndex.js';
import { SkillRegistry } from '../skill/skillRegistry.js';
import { RepoMapContextEngine } from '../context/repoMapContextEngine.js';
import { MemoryTodo } from '../adapters/todo/memoryTodo.js';
import { MemoryPlan } from '../adapters/plan/memoryPlan.js';
import { DefaultUserResponder } from '../adapters/user/defaultUserResponder.js';
import { JsonlStorage } from '../adapters/storage/jsonlStorage.js';
import { SqliteStorage } from '../adapters/storage/sqliteStorage.js';

/**
 * @beta
 * 子智能体运行时工厂：为单个子代构造隔离的 runtime 视图。
 *
 * 与父运行时共享 model/sandbox/approvals（复用连接与策略），
 * 但换掉 tools（受限子集）、events（内部桥接）、storage（重定位到隔离工作树下），
 * 并独立设置步数上限，从而使子代自动继承压缩、Spill、FFI 原生后端等全部既有能力，
 * 同时避免多个子代并发改写共享存储。
 */
export class SubagentRuntimeFactory {
  /** 构造子代 runtime 视图。 */
  public build(
    ports: SubagentPorts,
    tools: ToolPort,
    events: EventPort,
    maxSteps: number,
  ): OmniHarnessRuntime {
    // 子代存储重定位到隔离工作树（worktree.path / 拷贝目录）下，杜绝共享冲突。
    const storage = this.rerootStorage(ports.storage, ports.workspaceRoot);
    const config: ResolvedConfig = {
      workspaceRoot: ports.workspaceRoot,
      maxSteps,
      goalMaxIterations: ports.goalMaxIterations,
      model: ports.model,
      storage,
      approvals: ports.approvals,
      sandbox: ports.sandbox,
      escalation: ports.escalation,
      elevatedSandbox: ports.elevatedSandbox,
      events,
      tools,
      spill: ports.spill,
      spiller: ports.spiller,
      planMode: false,
      userResponder: new DefaultUserResponder(),
      todo: new MemoryTodo(),
      plan: new MemoryPlan(),
      discovery: new ToolDiscovery(),
      retrieval: new Bm25MemoryIndex(),
      longTermMemory: ports.longTermMemory,
      repoMapContext: new RepoMapContextEngine(),
      memoryExtractor: undefined,
      skillRegistry: new SkillRegistry(),
    };
    return {
      config,
      model: ports.model,
      tools,
      storage,
      events,
      sandbox: ports.sandbox,
      approvals: ports.approvals,
      escalation: ports.escalation,
      elevatedSandbox: ports.elevatedSandbox,
      spiller: ports.spiller,
      discovery: new ToolDiscovery(),
      retrieval: new Bm25MemoryIndex(),
      gate: new ToolGate(
        ports.approvals,
        ports.sandbox,
        undefined,
        false,
        ports.escalation,
        ports.elevatedSandbox,
      ),
      container: this.containerOf(ports, tools, events, storage),
      native: ports.native,
      longTermMemory: ports.longTermMemory,
      memoryExtractor: undefined,
    };
  }

  /**
   * 把存储根重定位到隔离工作树下 `.omni-storage` 子目录，使每个子代存储互不冲突。
   * 内存存储等无路径后端按实例隔离，直接复用；未知后端 fail-closed 原样返回（不静默共享父存储）。
   */
  private rerootStorage(storage: StoragePort, workspaceRoot: string): StoragePort {
    const dir = join(workspaceRoot, '.omni-storage');
    mkdirSync(dir, { recursive: true });
    if (storage instanceof JsonlStorage) {
      return new JsonlStorage(dir);
    }
    if (storage instanceof SqliteStorage) {
      return new SqliteStorage(join(dir, 'events.db'));
    }
    return storage;
  }

  /** 子代容器：与父隔离（register 重名即抛错），键名沿用标准 ServiceKeys。 */
  private containerOf(
    ports: SubagentPorts,
    tools: ToolPort,
    events: EventPort,
    storage: StoragePort,
  ): Container {
    const container = new Container();
    container.register(ServiceKeys.model, ports.model);
    container.register(ServiceKeys.storage, storage);
    container.register(ServiceKeys.sandbox, ports.sandbox);
    container.register(ServiceKeys.approvals, ports.approvals);
    container.register(ServiceKeys.tools, tools);
    container.register(ServiceKeys.events, events);
    return container;
  }
}

/** 组合根单例：纯无状态工厂，运行时装配一次，全局复用。 */
export const subagentRuntimeFactory = new SubagentRuntimeFactory();
