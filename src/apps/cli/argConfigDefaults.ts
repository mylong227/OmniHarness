import type { FileConfig } from '../../contracts/ports/config/fileConfig.ts';
import type { CliArgs } from './cliArgs.ts';

/**
 * `ArgParser.configDefaults` 的**分段映射**协作类（2026-10-31 从 argParser 抽出；该文件贴
 * 行数上限）。按域分四段：工具与资产 / 模型与凭据 / 存储审批权限 / 运维预算与互操作——
 * 每段只做「已定义才写」的平面映射，**不映射 = CLI 通道丢配置**（接线门禁 I5a 的老教训）。
 *
 * 凭据兜底（providerKeys → apiKey/baseUrl）依赖 ArgParser 的实例方法链
 * （`adapterPresets`），故模型段由调用方注入 `fillCredentials` 回调完成。
 */
export class ArgConfigDefaults {
  /**
   * 工具与资产段（reasoning / mcpServers / skills / media / capability / rbac / decisionEngine / modelRouter）。
   * @param file 配置文件对象。
   * @param result 累积结果（就地写）。
   * @returns 无返回值。
   */
  public static applyToolSection(file: FileConfig, result: Partial<CliArgs>): void {
    if (file.reasoning !== undefined) {
      result.reasoning = file.reasoning;
    }
    if (file.mcpServers !== undefined) {
      result.mcpServers = file.mcpServers.map((server) => ({
        ...(server.url !== undefined
          ? { name: server.name, url: server.url }
          : { name: server.name, command: server.command ?? '', args: server.args ?? [] }),
        ...(server.headers !== undefined ? { headers: server.headers } : {}),
        ...(server.auth !== undefined ? { auth: server.auth } : {}),
      }));
    }
    // 受种技能池：配置文件内联数组直接进 CLI 参数；`--skills <file.json>` 在装配层追加（同名以旗标为准）。
    if (file.skills !== undefined) {
      result.skills = file.skills;
    }
    // 媒体抽帧配置：整段透传（结构同一份，字段校验已在「配置文件归一化」阶段 fail-closed 完成）。
    if (file.media !== undefined) {
      result.media = file.media;
    }
    // 统一资产协议段（Wave B）：同上，整段透传。**不映射 = CLI 通道丢配置**——本仓已十次同形态，
    // 故此处与 `media` 一样显式接线（接线完整性门禁 I5a 会拦下遗漏）。
    if (file.capability !== undefined) {
      result.capability = file.capability;
    }
    // 角色门禁段（F3 RBAC-lite）：同上整段透传。**不映射 = CLI 通道丢配置**（接线门禁 I5a 会拦）。
    if (file.rbac !== undefined) {
      result.rbac = file.rbac;
    }
    // （Laya 战略线）决策引擎段：同上整段透传。**不映射 = CLI 通道丢配置**——而这一段丢掉的
    // 后果是「引擎恒不构造、1.7GB 权重零调用且全程无告警」，故与 media/capability/rbac 同一条路。
    if (file.decisionEngine !== undefined) {
      result.decisionEngine = file.decisionEngine;
    }
    if (file.modelRouter !== undefined) {
      result.modelRouter = file.modelRouter;
    }
  }

  /**
   * 模型与凭据段（adapter / baseUrl / apiKey / providerKeys 兜底 / model）。
   * @param file 配置文件对象。
   * @param result 累积结果（就地写）。
   * @param fillCredentials 凭据兜底回调（调用方实现：providerKeys 命中时补 apiKey/baseUrl）。
   * @returns 无返回值。
   */
  public static applyModel(
    file: FileConfig,
    result: Partial<CliArgs>,
    fillCredentials: () => void,
  ): void {
    if (file.modelAdapter !== undefined) {
      result.modelAdapter = file.modelAdapter;
    }
    if (file.baseUrl !== undefined) {
      result.baseUrl = file.baseUrl;
    }
    if (file.apiKey !== undefined) {
      result.apiKey = file.apiKey;
    }
    fillCredentials();
    if (file.model !== undefined) {
      result.model = file.model;
    }
  }

  /**
   * 存储与审批权限段（storage / approval / permission / ssrfPolicy / limits / sandbox /
   * 记忆加密 / escalation / workspace / maxSteps）。
   * @param file 配置文件对象。
   * @param result 累积结果（就地写）。
   * @param applyMemoryEncryption 记忆加密默认回调（逻辑在 ArgParser，单一来源不搬）。
   * @returns 无返回值。
   */
  public static applyStorageApproval(
    file: FileConfig,
    result: Partial<CliArgs>,
    applyMemoryEncryption: () => void,
  ): void {
    if (file.storageAdapter !== undefined) {
      result.storageAdapter = file.storageAdapter;
    }
    if (file.storageDir !== undefined) {
      result.storageDir = file.storageDir;
    }
    if (file.approval !== undefined) {
      result.approval = file.approval;
    }
    // 权限参数级规则（A2）：配置 permission 段透传给装配层，与内置规则合并。
    if (file.permission?.rules !== undefined) {
      result.permissionRules = file.permission.rules;
    }
    if (file.permission?.defaultDecision !== undefined) {
      result.permissionDefault = file.permission.defaultDecision;
    }
    // SSRF 策略表（可配置）：**修「声明未接线」**——此前从不映射 `file.ssrfPolicy`，
    // 于是 `args.ssrfPolicy` 恒为 undefined，写在 omniharness.json 里的策略表从未到达
    // 出站守卫与组合根（只有编程 API 路径生效）。接线完整性门禁 I5a 只对 src/cli 做字符串
    // 匹配（`args.ssrfPolicy` 足以命中），因此这条断链长期是绿的——2026-09-22 第二轮实测发现。
    if (file.ssrfPolicy !== undefined) result.ssrfPolicy = file.ssrfPolicy;
    // 运维限制段（2026-10-30 数据化）：**不映射 = CLI 通道丢配置**（与 ssrfPolicy 同一条路）。
    if (file.limits !== undefined) result.limits = file.limits;
    if (file.sandbox !== undefined) {
      result.sandbox = file.sandbox;
    }
    applyMemoryEncryption();
    if (file.escalation !== undefined) {
      result.escalation = file.escalation;
    }
    if (file.workspace !== undefined) {
      result.workspace = file.workspace;
    }
    if (file.maxSteps !== undefined) {
      result.maxSteps = file.maxSteps;
    }
  }

  /**
   * 运维预算与互操作段（熔断三元组 / 成本预算三元组 / elevatedSandbox / RLVR / A2A）。
   * @param file 配置文件对象。
   * @param result 累积结果（就地写）。
   * @param applyEvolutionRlvr RLVR 映射回调（逻辑在 ArgParser，单一来源不搬）。
   * @returns 无返回值。
   */
  public static applyOpsBudget(
    file: FileConfig,
    result: Partial<CliArgs>,
    applyEvolutionRlvr: () => void,
  ): void {
    if (file.modelCircuitBreaker !== undefined) {
      result.modelCircuitBreaker = file.modelCircuitBreaker;
    }
    if (file.modelCircuitBreakerThreshold !== undefined) {
      result.modelCircuitBreakerThreshold = file.modelCircuitBreakerThreshold;
    }
    if (file.modelCircuitBreakerOpenMs !== undefined) {
      result.modelCircuitBreakerOpenMs = file.modelCircuitBreakerOpenMs;
    }
    // (P5) 成本预算：文件对象形态 → 扁平 CliArgs 字段（CLI 旗标在更上层继续覆盖）。
    if (file.costBudgetUsd !== undefined) {
      result.costBudgetUsd = file.costBudgetUsd;
    }
    if (file.costBudgetOnExceed !== undefined) {
      result.costBudgetOnExceed = file.costBudgetOnExceed;
    }
    if (file.costBudgetSoftRatio !== undefined) {
      result.costBudgetSoftRatio = file.costBudgetSoftRatio;
    }
    if (file.elevatedSandbox !== undefined) {
      result.elevatedSandbox = file.elevatedSandbox;
    }
    // (U4) RLVR 进化闭环：文件对象形态 → 扁平 CliArgs 字段（CLI 旗标在更上层继续覆盖）。
    applyEvolutionRlvr();
    // (U6) A2A 互操作：文件对象形态 → 扁平 CliArgs 字段（CLI 旗标在更上层继续覆盖）。
    if (file.a2a !== undefined) {
      if (file.a2a.enabled !== undefined) {
        result.a2a = file.a2a.enabled;
      }
      if (file.a2a.port !== undefined) {
        result.a2aPort = file.a2a.port;
      }
      if (file.a2a.peerEndpoint !== undefined) {
        result.a2aPeer = file.a2a.peerEndpoint;
      }
      if (file.a2a.transport !== undefined) {
        result.a2aTransport = file.a2a.transport;
      }
    }
  }
}
