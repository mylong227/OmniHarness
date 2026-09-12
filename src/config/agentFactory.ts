import { Agent } from '../core/agent.js';
import type { AgentFactoryPort, AgentPort } from '../ports/agent.js';
import type { OmniHarnessRuntime } from '../core/runtime.js';

/**
 * Agent 工厂（组合根）：实现 {@link AgentFactoryPort}，按运行时构造 {@link Agent} 实例。
 * 置于 config/ 组合根——允许 import core 具体实现，供 adapters 经端口注入取得 Agent，
 * 避免 adapters 直接依赖 core（P1 分层解耦）。
 */
export class AgentFactory implements AgentFactoryPort {
  /** 构造一个 Agent 实例。 */
  public create(runtime: OmniHarnessRuntime): AgentPort {
    return new Agent(runtime);
  }
}
