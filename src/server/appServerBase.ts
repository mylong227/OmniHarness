import type { ApprovalDecision, ApprovalPort, ApprovalRequest } from '../ports/approval.js';
import type { EventPort } from '../ports/eventPort.js';
import type { ResolvedConfig } from '../config/omniharnessConfig.js';
import { RuntimeFactory } from '../core/runtime.js';
import { Agent } from '../core/agent.js';
import { PluginManager } from '../plugin/pluginManager.js';
import { loadInstalledPlugins } from '../plugin/pluginLoader.js';
import { PermissionGate } from '../plugin/permissionGate.js';
import { ALL_PERMISSIONS } from '../plugin/permission.js';
import { GraphStore } from '../autonomy/graphStore.js';
import { portsOf, type SubagentPorts } from '../subagent/subagentPorts.js';
import {
  applyProfile,
  type PluginProfile,
  type ApplyProfileResult,
} from '../plugin/pluginProfile.js';
import { Container } from '../core/container.js';
import { SandboxManager, type SandboxProfile } from '../adapters/sandbox/sandboxManager.js';
import { ConfigFactory } from '../config/omniharnessConfig.js';
import { ServiceKeys } from '../core/runtime.js';
import { JsonRpc, type RpcMessage } from './jsonRpc.js';
import type { AuditEvent } from './audit.js';
import { queryAudit, type AuditQuery } from './auditExport.js';
import { id } from '../util/id.js';
import { ConfigFile, type FileConfig } from '../config/configFile.js';
import { mergeConfigs } from '../config/configLayer.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { safeReadFile } from './safeFs.js';
import { homedir } from 'node:os';
import type {
  HealthSnapshot,
  SafeMode,
  SupervisorPort,
} from '../ports/supervisor.js';
import { spawnSync } from 'node:child_process';
import type { SessionEvent } from '../ports/event.js';

import { AUTO_ALLOW, DENY_ALL, RULES_DEFAULT, PERSISTABLE_KEYS } from './appServerState.js';
import type { AppServerOptions, GraphRunState } from './appServerState.js';
import { PROVIDER_PRESETS, providerPresetOf, maskKey } from './providerPresets.js';
import type { ProviderProbeResult } from './providerProbe.js';
import { probeProvider, buildModelForProvider } from './providerProbe.js';
import type { ModelPort } from '../ports/model.js';

/**
 * 由文件扩展名推断 mediaType（无 mime-types 依赖；零依赖铁律）。
 * 覆盖 attach.read 与 browseFs(includeFiles) 的输出。
 */
function inferMediaType(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  const ext = name.slice(dot + 1).toLowerCase();
  const map: Record<string, string> = {
    // 图片
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
    // 视频
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
    // 音频
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
    // 文本
    txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv',
    xml: 'application/xml', html: 'text/html', htm: 'text/html',
    // 文档
    pdf: 'application/pdf',
    // 压缩
    zip: 'application/zip', tar: 'application/x-tar', gz: 'application/gzip',
    // 代码（粗略，浏览器可能不识别但能下载/查看）
    ts: 'text/typescript', tsx: 'text/tsx', js: 'text/javascript', jsx: 'text/jsx',
    py: 'text/x-python', rs: 'text/x-rust', go: 'text/x-go', java: 'text/x-java',
  };
  return map[ext] ?? 'application/octet-stream';
}

/**
 * AppServer 共享基座：持有全部实例状态与核心助手方法。
 * 通过继承链拆解为 appServerHandlers（profile/bundle/plugin 处理器）与 appServer（叶：graph/memory/线程/调度），
 * 使每个文件 <400 行；方法体逐字节等价于原 appServer.ts，`private`→`protected`，零 `this.` 改写。
 */
export class AppServerBase {
  protected options: AppServerOptions;
  protected readonly threads = new Map<string, string>();
  /**
   * 探测结果缓存：厂商 id → 实测连通状态与真实模型清单。
   * 「检测」按钮与「启用此厂商」时填充；model.catalog 用它把 Composer 下拉
   * 换成当前厂商真实可用的模型（而非预设兜底清单）。
   */
  protected readonly probeCache = new Map<string, { ok: boolean; models: readonly string[] }>();
  protected readonly pendingApprovals = new Map<string, (decision: ApprovalDecision) => void>();
  protected readonly handlers = new Map<
    string,
    (params: Record<string, unknown>) => Promise<unknown>
  >();
  protected agent: Agent | undefined;
  protected autoApprove: boolean;
  protected displayConfig: Record<string, string>;
  /** UI 经 config.update 写入的字段覆盖（落盘 + 实时合并进 getConfig）。 */
  protected fieldOverrides: Partial<FileConfig> = {};
  /** 持久化目标路径（undefined 时按工作区推断并创建项目 omniharness.json）。 */
  protected configPath: string | undefined;
  /** 插件目录（构造时从 options 拷贝，确保 agentInstance 与 handler 一致）。 */
  protected pluginsDir?: string;
  /** 插件管理器（与 Agent 共享 port.tools 容器）；未配置目录则为 undefined。 */
  protected pluginManager?: PluginManager;
  /** 插件加载是否已尝试（幂等保护，避免重复初始化）。 */
  protected pluginsReady = false;
  /** 图定义持久化存储（G-C 多 Agent 编排，对标 codex agent-graph-store）。 */
  protected graphStore?: GraphStore;
  /** 子智能体端口集（供图运行复用，懒初始化）。 */
  protected graphPorts?: SubagentPorts;
  /** 进行中的图运行态（runId → 状态），供 graph.status 查询。 */
  protected readonly graphRuns = new Map<string, GraphRunState>();

  constructor(options: AppServerOptions) {
    this.options = options;
    this.autoApprove = options.autoApprove ?? false;
    this.displayConfig = options.displayConfig ?? {};
    this.configPath = options.configPath;
    this.pluginsDir = options.pluginsDir;
  }

  /** 启动阶段加载已安装插件（闭环 G-B：市场安装 → 运行时可用）。 */
  public async loadPlugins(): Promise<void> {
    await this.ensurePlugins();
  }

  /** 处理入站消息。 */
  protected async handle(message: RpcMessage): Promise<void> {
    if (!JsonRpc.isRequest(message)) {
      return;
    }
    const handler = this.handlers.get(message.method);
    if (handler === undefined) {
      this.options.transport.send(
        JsonRpc.errorResponse(message.id, -32601, `方法不存在: ${message.method}`),
      );
      return;
    }
    try {
      const result = await handler(message.params ?? {});
      this.options.transport.send(JsonRpc.response(message.id, result));
    } catch (error) {
      this.options.transport.send(JsonRpc.errorResponse(message.id, -32000, this.messageOf(error)));
    }
  }

  /** 提取错误消息。 */
  protected messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /** 事件端口：实时推送 thread.event 通知（并记录指标）。 */
  protected eventPort(): EventPort {
    return {
      name: 'server',
      emit: (event) => {
        this.options.metrics?.recordEvent(event);
        this.options.audit?.record({ type: event.type, sessionId: event.sessionId, detail: event });
        this.options.transport.send(
          JsonRpc.notify('thread.event', { threadId: event.sessionId, event }),
        );
      },
    };
  }

  /** 审批端口：上行至客户端。 */
  protected approvalPort(): ApprovalPort {
    return {
      name: 'server',
      decide: (request) => this.requestApproval(request),
    };
  }

  /**
   * 是否应跳过生产级 SupervisorKernel：仅 `--auto-approve`（对应 UI「工具全部自动放行」）
   * 即跳过（用户已显式选「完全访问」即终局授权，fail-closed safe-mode 拦截写类工具与
   * 该授权矛盾）。上一版曾叠加 `sandbox.name === 'passthrough'`，但生产默认 sandbox 是
   * policySandbox（用户配置文件未显式设 sandbox），导致绕过条件不命中，supervisor
   * 仍拒写文件（2026-09-07 用户截图反馈）。其余配置保持原 SupervisorKernel 不动——本判断
   * 是服务端唯一放宽点，调用方只需把它当 supervisor 覆盖项传入 `RuntimeFactory.create`。
   */
  protected bypassSupervisorKernel(config: ResolvedConfig): SupervisorPort | undefined {
    if (!this.autoApprove) return undefined;
    void config; // 仅 autoApprove 决定；sandbox 类型由 ToolGate / 升级路径自行处理
    return new ServerNoopSupervisor();
  }

  /**
   * 解析审批端口：上行 / 自动放行 / 配置端口三选一，并实时采纳 config.update 的 approval 覆盖。
   * 抽出来供 Agent 与图运行共用，避免两处审批逻辑漂移。
   */
  protected resolveApprovals(config: ResolvedConfig): ApprovalPort {
    const useUplink = this.options.approvalUplink === true && !this.autoApprove;
    let approvals: ApprovalPort = useUplink
      ? this.approvalPort()
      : this.autoApprove
        ? AUTO_ALLOW
        : config.approvals;
    const overrideApproval = this.fieldOverrides.approval;
    if (overrideApproval === 'auto') {
      approvals = AUTO_ALLOW;
    } else if (overrideApproval === 'deny') {
      approvals = DENY_ALL;
    } else if (overrideApproval === 'ask') {
      // 审批档：每次工具调用都经上行端口发 approval.request 等用户确认（UI 弹框）。
      approvals = this.approvalPort();
    } else if (overrideApproval === 'rules') {
      // 默认档：优先用启动时构建的 RuleApproval；若原配置是 auto/deny 被临时切过来，
      // 回退到内置默认 rules 端口，避免仍沿用旧的 AutoApproval/DenyAll。
      approvals = config.approvals.name === 'rules' ? config.approvals : RULES_DEFAULT;
    }
    return approvals;
  }

  /** 构建 Agent（覆盖事件端口；审批按需上行；UI 覆盖的模型配置实时生效）。 */
  protected agentInstance(): Agent {
    if (this.agent === undefined) {
      const config = this.options.config;
      const modelOverride = this.resolveModelOverride();
      const serverConfig: ResolvedConfig = {
        ...config,
        ...(modelOverride !== undefined ? { model: modelOverride } : {}),
        events: this.eventPort(),
        approvals: this.resolveApprovals(config),
      };
      const supervisor = this.bypassSupervisorKernel(serverConfig);
      this.agent = new Agent(
        RuntimeFactory.create(
          supervisor !== undefined ? { ...serverConfig, supervisor } : serverConfig,
        ),
        this.options.skills,
      );
    }
    return this.agent;
  }

  /** 懒初始化图存储（工作区 .omniharness/graphs）。 */
  protected graphStoreOf(): GraphStore {
    if (this.graphStore === undefined) {
      const root = this.effectiveWorkspace();
      this.graphStore = new GraphStore(root);
    }
    return this.graphStore;
  }

  /** 懒初始化子智能体端口集（供图运行复用同一运行时能力）。 */
  protected graphPortsOf(): SubagentPorts {
    if (this.graphPorts === undefined) {
      const config = this.options.config;
      const serverConfig: ResolvedConfig = {
        ...config,
        events: this.eventPort(),
        // 图运行是用户显式触发的「一键编排」：子步骤程序化执行，
        // 不应走交互式上行审批（否则 headless / 无人应答时永久挂死）。
        // 用户点击「运行」即视为已授权，固定 AUTO_ALLOW（与 CLI workflow 命令语义一致）。
        approvals: AUTO_ALLOW,
      };
      const supervisor = this.bypassSupervisorKernel(serverConfig);
      this.graphPorts = portsOf(
        RuntimeFactory.create(
          supervisor !== undefined ? { ...serverConfig, supervisor } : serverConfig,
        ),
      );
    }
    return this.graphPorts;
  }

  /**
   * 初始化插件容器并加载已安装插件（幂等）。
   * 容器复用与 Agent 相同的标准端口实例，故插件注册进 port.tools 即对 Agent 可见。
   */
  protected async ensurePlugins(): Promise<void> {
    if (this.pluginsReady) {
      return;
    }
    this.pluginsReady = true;
    const pluginsDir = this.pluginsDir;
    if (pluginsDir === undefined) {
      return;
    }
    try {
      const container = new Container();
      container.register(ServiceKeys.model, this.options.config.model);
      container.register(ServiceKeys.tools, this.options.config.tools);
      container.register(ServiceKeys.storage, this.options.config.storage);
      container.register(ServiceKeys.events, this.options.config.events);
      container.register(ServiceKeys.sandbox, this.options.config.sandbox);
      container.register(ServiceKeys.approvals, this.options.config.approvals);
      const manager = new PluginManager(container, PermissionGate.fromList(ALL_PERMISSIONS));
      this.pluginManager = manager;
      const loaded = await loadInstalledPlugins(manager, pluginsDir, (name, error) =>
        this.options.transport.send(
          JsonRpc.notify('plugin.loadError', { name, error: this.messageOf(error) }),
        ),
      );
      if (loaded.length > 0) {
        this.options.transport.send(JsonRpc.notify('plugin.loaded', { names: loaded }));
      }
    } catch (error) {
      this.options.transport.send(
        JsonRpc.notify('plugin.loadError', { error: this.messageOf(error) }),
      );
    }
  }

  /** 应用插件集 Profile（CLI --plugin-profile / 编程入口复用本方法）。 */
  public async applyPluginProfile(profile: PluginProfile): Promise<ApplyProfileResult> {
    await this.ensurePlugins();
    const registry = this.options.registry;
    const manager = this.pluginManager;
    const pluginsDir = this.pluginsDir;
    if (registry === undefined || manager === undefined || pluginsDir === undefined) {
      throw new Error('插件系统未初始化（serve 需注入 registry/pluginsDir）');
    }
    return applyProfile(manager, pluginsDir, registry, profile, {
      onInstall: (name) =>
        this.options.transport.send(JsonRpc.notify('profile.event', { type: 'install', name })),
      onLoad: (name) =>
        this.options.transport.send(JsonRpc.notify('profile.event', { type: 'load', name })),
      onUnload: (name) =>
        this.options.transport.send(JsonRpc.notify('profile.event', { type: 'unload', name })),
      onError: (name, error) =>
        this.options.transport.send(
          JsonRpc.notify('profile.error', { name, error: this.messageOf(error) }),
        ),
    });
  }

  /**
   * 可读配置摘要（供 UI 设置面板；实时合并已落盘文件值与 UI 覆盖）。
   * apiKey/providerKeys 一律打码——凭据原文永不回传 UI。
   */
  protected getConfig(): unknown {
    const merged: Record<string, unknown> = {
      ...this.displayConfig,
      ...this.effectiveFileConfig(),
      ...this.fieldOverrides,
      autoApprove: this.autoApprove,
    };
    if (typeof merged['apiKey'] === 'string' && merged['apiKey'] !== '') {
      merged['apiKey'] = maskKey(merged['apiKey']);
    }
    const pk = merged['providerKeys'];
    if (pk !== undefined && typeof pk === 'object' && !Array.isArray(pk)) {
      const masked: Record<string, string> = {};
      for (const [vendor, key] of Object.entries(pk as Record<string, unknown>)) {
        if (typeof key === 'string') masked[vendor] = maskKey(key);
      }
      merged['providerKeys'] = masked;
    }
    return merged;
  }

  /** 生效的文件级配置：已落盘文件 + UI 覆盖（探测/摘要共用，避免两处取值漂移）。 */
  protected effectiveFileConfig(): FileConfig {
    const path =
      this.configPath ??
      join(this.displayConfig['workspace'] ?? process.cwd(), ConfigFile.FILE_NAME);
    return mergeConfigs(ConfigFile.load(path), this.fieldOverrides);
  }

  /**
   * 探测厂商连通性（#模型接入页）：对 providerKeys 中已配 Key 的厂商与/或指定厂商
   * 发起真实 /models 请求，返回实测状态与模型清单。「有 Key 支持接多少显示多少」的数据源。
   */
  protected async probeModels(params: Record<string, unknown>): Promise<unknown> {
    const requested = typeof params['provider'] === 'string' ? params['provider'] : undefined;
    const file = this.effectiveFileConfig();
    const keys: Record<string, string> = { ...(file.providerKeys ?? {}) };
    const activeAdapter = file.modelAdapter;
    const presets = PROVIDER_PRESETS.filter((p) => requested === undefined || p.id === requested);
    const results: ProviderProbeResult[] = [];
    for (const preset of presets) {
      let key = keys[preset.id];
      // 活动厂商走顶层 apiKey（兼容老配置：modelAdapter+apiKey 直配）。
      if (
        key === undefined &&
        preset.needsKey &&
        activeAdapter === preset.adapter &&
        typeof file.apiKey === 'string'
      ) {
        key = file.apiKey;
      }
      const probed = await probeProvider(preset, key);
      results.push(probed);
      this.probeCache.set(preset.id, { ok: probed.ok, models: probed.models });
    }
    return { providers: results };
  }

  /**
   * 厂商目录 RPC：返回预设清单（无凭据）+ 当前厂商与其可用模型（UI 模型下拉按此过滤）。
   * 当前厂商判定：baseUrl 精确匹配预设 → 否则按 modelAdapter 匹配的第一个预设。
   * 模型清单 = 预设兜底清单 ∪ 当前配置模型（保证下拉恒含现值）。
   */
  protected modelCatalog(): unknown {
    const file = this.effectiveFileConfig();
    const adapter = this.fieldOverrides.modelAdapter ?? file.modelAdapter;
    const byAdapter = PROVIDER_PRESETS.filter((p) => p.adapter === adapter);
    const active =
      PROVIDER_PRESETS.find((p) => file.baseUrl !== undefined && file.baseUrl === p.baseUrl) ??
      byAdapter[0];
    const activeInfo =
      active === undefined
        ? undefined
        : {
            id: active.id,
            label: active.label,
            defaultModel: active.defaultModel,
            model: file.model ?? active.defaultModel,
            // 只返回真实可用模型：有实测缓存（检测/启用时探测过）用真实清单；否则只保留当前值，
            // 不再 fallback 到预设兜底清单，避免 UI 展示未经检测的假列表。
            models: Array.from(
              new Set(
                [
                  file.model ?? '',
                  ...((this.probeCache.get(active.id)?.ok ?? false)
                    ? this.probeCache.get(active.id)!.models
                    : []),
                ].filter(Boolean),
              ),
            ),
            // 推理强度档位（#B6 扩展，2026-09-08）：仅当下拉动态档位可用时下发；
            // undefined 时 UI 退回内置兜底列表（向后兼容）。空数组表示该厂商无 effort 档位。
            reasoningEffort: active.reasoningEffort,
          };
    return { providers: PROVIDER_PRESETS, active: activeInfo };
  }

  /**
   * 文件夹浏览 RPC（「+ 添加项目」）：列出某目录下的子目录，供 UI 内嵌文件夹选择器。
   * path 缺省时返回 Windows 盘符列表 + 用户目录（服务端跑在本机——这是浏览器沙箱
   * 拿不到真实绝对路径时唯一能给出真路径的方案，替代手输弹框）。
   */
  protected browseFs(params: Record<string, unknown>): unknown {
    const raw = params['path'];
    const includeFiles = params['includeFiles'] === true;
    if (typeof raw !== 'string' || raw.trim() === '') {
      const roots: string[] = [];
      for (let i = 65; i <= 90; i += 1) {
        const letter = `${String.fromCharCode(i)}:\\`;
        if (existsSync(letter)) roots.push(letter);
      }
      return { level: 'drives' as const, roots, home: homedir() };
    }
    const target = resolve(raw.trim());
    let entries: Dirent[];
    try {
      entries = readdirSync(target, { withFileTypes: true });
    } catch (e) {
      throw new Error(`无法读取目录 ${target}：${(e as Error).message}`);
    }
    const dirs = entries
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { sensitivity: 'base' }));
    const result: {
      level: 'dir';
      path: string;
      parent?: string;
      dirs: string[];
      files?: { name: string; size: number; mediaType: string }[];
    } = {
      level: 'dir' as const,
      path: target,
      parent: dirname(target) === target ? undefined : dirname(target),
      dirs,
    };
    if (includeFiles) {
      const files: { name: string; size: number; mediaType: string }[] = [];
      for (const e of entries) {
        if (!e.isFile()) continue;
        let st;
        try {
          st = statSync(join(target, e.name));
        } catch {
          continue;
        }
        files.push({ name: e.name, size: st.size, mediaType: inferMediaType(e.name) });
      }
      files.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { sensitivity: 'base' }));
      result.files = files;
    }
    return result;
  }

  /**
   * 附件读取 RPC（FilePicker 选完文件后批量读 base64）：专为 Composer 附加文件设计，
   * 不限工作区（用户主动从全盘选），但有硬性白名单 + 大小限制兜底安全：
   *   - 单文件 ≤ 20MB、单次 ≤ 50 个、总大小未限（base64 后服务端内存瞬时翻 ~1.37x）
   *   - 类型白名单：image/* / video/* / audio/* / text/* / application/pdf|json|zip
   *   - 路径必须 resolve 后存在且 isFile()，单文件失败不阻断整体（errors[] 收集）
   *   - 不做工作区越界检查（设计意图：附件是用户主动跨工作区选）
   */
  protected attachRead(params: Record<string, unknown>): unknown {
    const paths = params['paths'];
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error('paths 必须是非空数组');
    }
    if (paths.length > 50) {
      throw new Error('单次最多附加 50 个文件');
    }
    const files: {
      name: string;
      mediaType: string;
      data: string;
      size: number;
      kind: 'image' | 'video' | 'audio' | 'file';
    }[] = [];
    const errors: { path: string; error: string }[] = [];
    for (const p of paths) {
      if (typeof p !== 'string' || p.trim() === '') {
        errors.push({ path: String(p), error: '路径无效' });
        continue;
      }
      const target = resolve(p.trim());
      let st;
      try {
        st = statSync(target);
      } catch (e) {
        errors.push({ path: target, error: '文件不存在或不可访问：' + (e as Error).message });
        continue;
      }
      if (!st.isFile()) {
        errors.push({ path: target, error: '不是文件' });
        continue;
      }
      if (st.size > 20 * 1024 * 1024) {
        errors.push({ path: target, error: '文件超过 20MB 限制' });
        continue;
      }
      const name = basename(target);
      const mediaType = inferMediaType(name);
      const allowedPrefixes = [
        'image/',
        'video/',
        'audio/',
        'text/',
        'application/pdf',
        'application/json',
        'application/zip',
      ];
      if (!allowedPrefixes.some((p) => mediaType.startsWith(p))) {
        errors.push({ path: target, error: '不支持的文件类型：' + mediaType });
        continue;
      }
      let buf: Buffer;
      try {
        buf = readFileSync(target);
      } catch (e) {
        errors.push({ path: target, error: '读取失败：' + (e as Error).message });
        continue;
      }
      const data = buf.toString('base64');
      const kind: 'image' | 'video' | 'audio' | 'file' = mediaType.startsWith('image/')
        ? 'image'
        : mediaType.startsWith('video/')
          ? 'video'
          : mediaType.startsWith('audio/')
            ? 'audio'
            : 'file';
      files.push({ name, mediaType, data, size: st.size, kind });
    }
    return { files, errors };
  }

  /**
   * 新建文件夹 RPC（「+ 新建项目」）：在指定父目录下创建子文件夹，返回新目录的绝对路径。
   * 名称做安全裁剪——拒绝路径分隔符 / 空名 / 越级（..），保证只在 parent 内落盘，
   * 不会因 UI 传入恶意名而在任意位置建目录（fail-closed：任何异常原样抛给前端显错）。
   */
  protected mkdirFs(params: Record<string, unknown>): unknown {
    const parentRaw = params['parent'];
    const nameRaw = params['name'];
    if (typeof parentRaw !== 'string' || parentRaw.trim() === '') {
      throw new Error('请先进入一个目录再新建文件夹');
    }
    if (typeof nameRaw !== 'string' || nameRaw.trim() === '') {
      throw new Error('文件夹名称不能为空');
    }
    const name = nameRaw
      .trim()
      .replace(/[\\/]+/g, '')
      .replace(/^[\.]+|[\0<>:"|?*]/g, '');
    if (name === '' || name === '.' || name === '..') {
      throw new Error('非法的文件夹名称：' + nameRaw);
    }
    const parent = resolve(parentRaw.trim());
    if (!existsSync(parent) || !statSync(parent).isDirectory()) {
      throw new Error('父目录不存在：' + parent);
    }
    const target = join(parent, name);
    if (existsSync(target)) {
      throw new Error('该文件夹已存在：' + target);
    }
    mkdirSync(target, { recursive: false });
    return { path: target };
  }

  /**
   * Token 消耗统计 RPC：扫描会话存储目录（每会话一个 .jsonl）聚合 type='model' 事件，
   * 按模型与会话分组返回调用次数 / prompt / completion / total。磁盘无数据时回退
   * 进程内 metrics（诚实标注来源，不混算避免重启后双计）。
   */
  protected usageStats(): unknown {
    interface ModelStat {
      calls: number;
      prompt: number;
      completion: number;
      total: number;
    }
    const bump = (map: Map<string, ModelStat>, model: string, p: number, c: number): void => {
      const prev = map.get(model) ?? { calls: 0, prompt: 0, completion: 0, total: 0 };
      map.set(model, {
        calls: prev.calls + 1,
        prompt: prev.prompt + p,
        completion: prev.completion + c,
        total: prev.total + p + c,
      });
    };

    const ws = this.effectiveWorkspace();
    const file = this.effectiveFileConfig();
    // 优先问正在用的 StoragePort 要物理位置（CLI 默认在 ~/.omniharness/sessions，未必是工作区相对路径）；
    // sqlite 等非文件后端 location 非 .jsonl 目录，扫描自然为空 → 自动回退进程内统计。
    const storage = (this.options as { config: ResolvedConfig }).config.storage;
    const dir = storage.location ?? resolve(ws, file.storageDir ?? '.omniharness/sessions');
    const byModel = new Map<string, ModelStat>();
    const sessions: { sessionId: string; calls: number; total: number }[] = [];

    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.jsonl')) continue;
        let lines: string[] = [];
        try {
          lines = readFileSync(join(dir, name), 'utf8').split('\n');
        } catch {
          continue;
        }
        let calls = 0;
        let total = 0;
        for (const line of lines) {
          if (line.trim() === '') continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line) as unknown;
          } catch {
            continue;
          }
          const ev = parsed as {
            type?: string;
            payload?: { usage?: Record<string, number>; model?: string };
          };
          if (ev?.type !== 'model') continue;
          const usage = ev.payload?.usage;
          if (usage === undefined) continue;
          const p = Number(usage['promptTokens'] ?? 0);
          const c = Number(usage['completionTokens'] ?? 0);
          bump(byModel, ev.payload?.model ?? 'unknown', p, c);
          calls += 1;
          total += p + c;
        }
        if (calls > 0) {
          sessions.push({ sessionId: name.replace(/\.jsonl$/, ''), calls, total });
        }
      }
    }

    if (sessions.length > 0) {
      const totalStat = { calls: 0, prompt: 0, completion: 0, total: 0 };
      for (const m of byModel.values()) {
        totalStat.calls += m.calls;
        totalStat.prompt += m.prompt;
        totalStat.completion += m.completion;
        totalStat.total += m.total;
      }
      sessions.sort((a, b) => b.total - a.total);
      return {
        source: 'disk',
        dir,
        byModel: Object.fromEntries(byModel),
        total: totalStat,
        sessions,
      };
    }

    // 回退：磁盘无历史（新装/存储为 memory），用进程内累计（重启清零）。
    const live = this.options.metrics?.snapshot().tokens ?? {};
    const liveTotal = { calls: 0, prompt: 0, completion: 0, total: 0 };
    for (const m of Object.values(live)) {
      liveTotal.calls += m.calls;
      liveTotal.prompt += m.prompt;
      liveTotal.completion += m.completion;
      liveTotal.total += m.total;
    }
    return { source: 'live', dir, byModel: live, total: liveTotal, sessions: [] };
  }

  /**
   * 会话列表 RPC：扫描 StoragePort 实际位置下全部会话存档，提取工作区标记
   * （session_meta 事件）与首条用户消息（作标签），供 UI 按项目收纳、切换项目查看对应会话。
   * 无标记的历史会话 workspace 为 undefined，UI 归入「更早会话」组。
   */
  protected listSessions(): unknown {
    const storage = (this.options as { config: ResolvedConfig }).config.storage;
    const dir = storage.location;
    if (dir === undefined || !existsSync(dir) || !statSync(dir).isDirectory()) {
      return { dir, sessions: [] };
    }
    interface SessionInfo {
      sessionId: string;
      workspace?: string;
      label: string;
      turns: number;
      updatedAt: string;
      mtimeMs: number;
    }
    const sessions: SessionInfo[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      let lines: string[] = [];
      try {
        lines = readFileSync(join(dir, name), 'utf8').split('\n');
      } catch {
        continue;
      }
      let workspace: string | undefined;
      let label = '';
      let turns = 0;
      let updatedAt = '';
      for (const line of lines) {
        if (line.trim() === '') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          continue;
        }
        const ev = parsed as {
          type?: string;
          timestamp?: string;
          payload?: Record<string, unknown>;
        };
        if (ev.type === 'session_meta' && typeof ev.payload?.['workspace'] === 'string') {
          workspace = ev.payload['workspace'];
        } else if (ev.type === 'user' && label === '') {
          const content = ev.payload?.['content'];
          if (typeof content === 'string') label = content.slice(0, 80);
          turns += 1;
        } else if (ev.type === 'user') {
          turns += 1;
        }
        if (typeof ev.timestamp === 'string') updatedAt = ev.timestamp;
      }
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(join(dir, name)).mtimeMs;
      } catch {
        /* 文件消失竞态：跳过 mtime */
      }
      sessions.push({
        sessionId: name.replace(/\.jsonl$/, ''),
        workspace,
        label,
        turns,
        updatedAt,
        mtimeMs,
      });
    }
    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { dir, sessions };
  }

  /**
   * 工作区变更记录 RPC（git 式）：工作区是 git 仓库时用 `git status --porcelain` +
   * `git diff --numstat HEAD` 产出真实变更清单；非 git 工作区回退为聚合指定线程
   * （或最近线程）turn_diff 事件里的 per 文件增删行数。params.path 传入时返回该文件 patch。
   */
  protected async listChanges(params: Record<string, unknown>): Promise<unknown> {
    const ws = this.effectiveWorkspace();
    const fileParam = typeof params['path'] === 'string' ? params['path'] : undefined;

    const git = this.gitChanges(ws, fileParam);
    if (git !== null) return git;
    return this.sessionChanges(ws, fileParam);
  }

  /** git 仓库变更：返回 null 表示不是 git 仓库（或 git 不可用）。 */
  private gitChanges(ws: string, fileParam: string | undefined): unknown | null {
    const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: ws,
      encoding: 'utf8',
    });
    if (inside.status !== 0 || inside.stdout.trim() !== 'true') return null;

    if (fileParam !== undefined) {
      // 单文件 patch：已跟踪用 git diff HEAD；未跟踪（??）直接读文件内容构造全 + patch。
      const status = spawnSync('git', ['status', '--porcelain', '--', fileParam], {
        cwd: ws,
        encoding: 'utf8',
      });
      if (status.stdout.startsWith('??')) {
        let content = '';
        try {
          content = readFileSync(resolve(ws, fileParam), 'utf8');
        } catch {
          content = '';
        }
        const body = content
          .split('\n')
          .map((l) => '+' + l)
          .join('\n');
        return { source: 'git', patch: `--- /dev/null\n+++ ${fileParam}\n${body}` };
      }
      const diff = spawnSync('git', ['diff', 'HEAD', '--', fileParam], {
        cwd: ws,
        encoding: 'utf8',
      });
      return { source: 'git', patch: diff.status === 0 ? diff.stdout : '' };
    }

    const branchRes = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: ws,
      encoding: 'utf8',
    });
    const status = spawnSync('git', ['status', '--porcelain', '-uall'], {
      cwd: ws,
      encoding: 'utf8',
    });
    const numstat = spawnSync('git', ['diff', '--numstat', 'HEAD'], { cwd: ws, encoding: 'utf8' });
    if (status.status !== 0) return { source: 'git', branch: branchRes.stdout.trim(), files: [] };

    const stats = new Map<string, { additions: number; deletions: number }>();
    for (const line of (numstat.stdout ?? '').split('\n')) {
      if (line.trim() === '') continue;
      const [add, del, ...rest] = line.split('\t');
      const path = rest.join('\t');
      if (path === '') continue;
      stats.set(path, {
        additions: add === '-' ? 0 : Number(add),
        deletions: del === '-' ? 0 : Number(del),
      });
    }
    const files = status.stdout
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((line) => {
        const st = line.slice(0, 2).trim() || 'M';
        let path = line.slice(3).trim();
        // 重命名格式 "old -> new"：以新路径为准。
        if (path.includes(' -> ')) path = path.split(' -> ').pop() ?? path;
        if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
        let additions = 0;
        let deletions = 0;
        const known = stats.get(path);
        if (known !== undefined) {
          additions = known.additions;
          deletions = known.deletions;
        } else if (st === 'A' || st === '??') {
          // 新增文件：numstat 不含未跟踪，按行数记 +
          try {
            additions = readFileSync(resolve(ws, path), 'utf8').split('\n').length;
          } catch {
            additions = 0;
          }
        }
        return { path, status: st, additions, deletions };
      });
    return { source: 'git', branch: branchRes.stdout.trim(), files };
  }

  /**
   * 非 git 工作区回退：聚合已知线程 turn_diff 事件，按 unified diff 的 `diff --git`
   * 分段解析出 per 文件增删行数；params.path 传入时返回该文件的原始 patch 拼接。
   */
  private async sessionChanges(ws: string, fileParam: string | undefined): Promise<unknown> {
    void ws;
    const sections = new Map<string, string[]>();
    const stats = new Map<string, { additions: number; deletions: number }>();
    for (const threadId of this.threads.keys()) {
      let events: readonly SessionEvent[] = [];
      try {
        events = await this.agentInstance().replay(threadId);
      } catch {
        continue;
      }
      for (const ev of events) {
        if (ev.type !== 'turn_diff') continue;
        const diff = (ev.payload as { diff?: string } | undefined)?.diff ?? '';
        let path = '';
        let body: string[] = [];
        let add = 0;
        let del = 0;
        const flush = (): void => {
          if (path === '') return;
          const prev = stats.get(path) ?? { additions: 0, deletions: 0 };
          stats.set(path, { additions: prev.additions + add, deletions: prev.deletions + del });
          const list = sections.get(path) ?? [];
          list.push(body.join('\n'));
          sections.set(path, list);
          path = '';
          body = [];
          add = 0;
          del = 0;
        };
        for (const line of diff.split('\n')) {
          if (line.startsWith('diff --git')) {
            flush();
          } else if (line.startsWith('+++ ')) {
            path = line.slice(4).replace(/^b\//, '').trim();
            body.push(line);
          } else if (path !== '') {
            body.push(line);
            if (line.startsWith('+')) add += 1;
            else if (line.startsWith('-')) del += 1;
          }
        }
        flush();
      }
    }
    if (fileParam !== undefined) {
      return { source: 'session', patch: (sections.get(fileParam) ?? []).join('\n') };
    }
    return {
      source: 'session',
      files: [...stats.entries()].map(([path, s]) => ({
        path,
        status: 'M',
        additions: s.additions,
        deletions: s.deletions,
      })),
    };
  }

  /**
   * UI 覆盖的运行时模型（agent 重建用）：仅当 fieldOverrides 显式设置了 modelAdapter 时生效。
   * mock 保持启动时模型不动；其余按覆盖字段构造真适配器，Key 缺失 fail-closed 抛可读错误。
   */
  protected resolveModelOverride(): ModelPort | undefined {
    // 适配器来源：UI 覆盖优先，回退落盘配置（修复「serve 以 mock 启动后，配置文件里
    // 已启用真模型但运行时仍用 mock」的断裂——磁盘配置此前只在重启时才被读到）。
    const file = this.effectiveFileConfig();
    const adapter = this.fieldOverrides.modelAdapter ?? file.modelAdapter;
    if (adapter === undefined || adapter === 'mock' || adapter === 'llamacpp') {
      return undefined;
    }
    const candidates = PROVIDER_PRESETS.filter((p) => p.adapter === adapter);
    const preset = candidates[0];
    if (preset === undefined) {
      return undefined;
    }
    const apiKey =
      file.apiKey ??
      file.providerKeys?.[preset.id] ??
      (adapter === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY);
    const effectivePreset =
      file.baseUrl !== undefined ? { ...preset, baseUrl: file.baseUrl } : preset;
    return buildModelForProvider(effectivePreset, apiKey ?? undefined, file.model);
  }

  /**
   * 更新服务端配置：autoApprove 切换 + 持久化 FileConfig 字段到 omniharness.json。
   * 特殊动作参数（不落盘，消费后即弃）：
   *   setProviderKey: { vendor, key } —— 单厂商 Key 原子合并/清除（UI 只持有打码值，不能整表替换）。
   *   enableProvider: string（配合 model 选模型）—— 一键启用厂商：写 modelAdapter/baseUrl/model/apiKey。
   * 落盘走 ConfigFile.save 的归一化校验（fail-closed：非法枚举/类型直接回 RPC 错误）。
   */
  protected async updateConfig(params: Record<string, unknown>): Promise<unknown> {
    const aa = params['autoApprove'];
    if (aa === true || aa === false) {
      this.autoApprove = aa;
    }
    const patch: Record<string, unknown> = {};
    for (const key of PERSISTABLE_KEYS) {
      const value = params[key];
      if (value !== undefined) {
        patch[key] = value;
      }
    }
    const setKey = params['setProviderKey'];
    if (setKey !== undefined && typeof setKey === 'object' && setKey !== null) {
      const vendor = (setKey as Record<string, unknown>)['vendor'];
      const key = (setKey as Record<string, unknown>)['key'];
      if (typeof vendor === 'string' && providerPresetOf(vendor) !== undefined) {
        const merged = { ...this.effectiveFileConfig().providerKeys };
        if (typeof key === 'string' && key.length > 0) {
          merged[vendor] = key;
        } else {
          delete merged[vendor]; // 空 Key = 清除该厂商凭据
        }
        patch.providerKeys = merged;
      }
    }
    const enable = params['enableProvider'];
    if (typeof enable === 'string') {
      const preset = providerPresetOf(enable);
      if (preset !== undefined) {
        const keys = this.effectiveFileConfig().providerKeys ?? {};
        const key = keys[enable];
        if (preset.needsKey && key === undefined) {
          throw new Error(`厂商 ${preset.label} 尚未保存 API Key，请先填写并保存`);
        }
        patch.modelAdapter = preset.adapter;
        patch.baseUrl = preset.baseUrl;
        const chosen = params['model'];
        patch.model =
          typeof chosen === 'string' && chosen.length > 0 ? chosen : preset.defaultModel;
        if (key !== undefined) {
          patch.apiKey = key; // 运行时构造优先取顶层 apiKey，启用即同步
        }
        // 启用即实测：探测真实 /models 清单进缓存，Composer 下拉立即显示真实可用模型。
        // 探测失败不阻断启用（fail-open 到预设清单），错误由下次「检测」刷新。
        const probed = await probeProvider(preset, key);
        this.probeCache.set(preset.id, { ok: probed.ok, models: probed.models });
      }
    }
    if (Object.keys(patch).length > 0) {
      this.fieldOverrides = mergeConfigs(this.fieldOverrides, patch as Partial<FileConfig>);
      this.persistConfig();
    }
    this.agent = undefined; // 下次回合按新配置重建
    return { ok: true, saved: this.configPath, autoApprove: this.autoApprove };
  }

  /** 审计查询 RPC：读取服务端审计 sink 并应用过滤条件返回事件数组。 */
  protected queryAuditRpc(params: Record<string, unknown>): AuditEvent[] {
    const sink = this.options.audit;
    if (sink === undefined) return [];
    const str = (v: unknown): string | undefined =>
      typeof v === 'string' && v.length > 0 ? v : undefined;
    const num = (v: unknown): number | undefined => {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
      return undefined;
    };
    const query: AuditQuery = {
      since: str(params['since']),
      until: str(params['until']),
      type: str(params['type']),
      session: str(params['session']),
      actor: str(params['actor']),
      limit: num(params['limit']),
    };
    return queryAudit(sink.read(), query);
  }

  /** 把覆盖配置合并进项目配置文件并写盘（目录不存在自动创建）。 */
  /** 当前生效工作区根目录（UI 覆盖优先，回退启动参数 → cwd）。 */
  /**
   * 当前生效的工作区根（#OBS-11）：HTTP /files 路由与 RPC fs.read 共用。
   * public：HTTP 路由需要直接读取以注入到 HttpServerOptions.workspaceRoot。
   */
  public effectiveWorkspace(): string {
    return this.fieldOverrides.workspace ?? this.displayConfig['workspace'] ?? process.cwd();
  }

  /** 工作区列表（UI「添加项目」维护）：已落盘列表 ∪ 当前生效工作区，去重保序。 */
  protected listWorkspaces(): { current: string; workspaces: string[] } {
    const saved = this.effectiveFileConfig().workspaces ?? [];
    const current = this.effectiveWorkspace();
    return { current, workspaces: [...new Set([current, ...saved])] };
  }

  /** 校验候选路径为存在目录并返回绝对路径；fail-closed：不存在/非目录直接抛错回 RPC。 */
  protected requireDirectory(raw: unknown): string {
    const candidate = typeof raw === 'string' ? raw.trim() : '';
    if (candidate === '') {
      throw new Error('路径不能为空');
    }
    const root = resolve(candidate);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new Error('目录不存在或不是文件夹: ' + root);
    }
    return root;
  }

  /** 「添加项目」：校验目录后并入 workspaces 列表并持久化。 */
  protected addWorkspace(raw: unknown): unknown {
    const root = this.requireDirectory(raw);
    const list = this.effectiveFileConfig().workspaces ?? [];
    if (!list.includes(root)) {
      this.fieldOverrides = { ...this.fieldOverrides, workspaces: [...list, root] };
      this.persistConfig();
    }
    return this.listWorkspaces();
  }

  /**
   * 「切换项目」：按新工作区根目录重建运行时组件（sandbox/hooks/memory/spill 等全部
   * 随 ConfigFactory.build 按新 root 重造），清 agent/graph 缓存，下回合即在新工作区执行。
   * 审批/模型覆盖沿用现有解析逻辑，UI 感知零断裂。
   */
  protected switchWorkspace(raw: unknown): unknown {
    const root = this.requireDirectory(raw);
    if (root === this.effectiveWorkspace()) {
      return { ok: true, workspace: root, unchanged: true };
    }
    const cfg = this.options.config;
    const file = this.effectiveFileConfig();
    const sandbox = new SandboxManager(root).build((file.sandbox ?? 'policy') as SandboxProfile);
    const rebuilt = ConfigFactory.build({
      workspaceRoot: root,
      maxSteps: cfg.maxSteps,
      model: this.resolveModelOverride() ?? cfg.model,
      storage: cfg.storage,
      events: this.eventPort(),
      approvals: this.resolveApprovals(cfg),
      sandbox,
      escalation: cfg.escalation,
      reasoning: file.reasoning ?? cfg.reasoning,
    });
    (this.options as { config: ResolvedConfig }).config = rebuilt;
    this.agent = undefined;
    this.graphStore = undefined;
    this.graphPorts = undefined;
    const previous = this.effectiveWorkspace();
    const saved = this.effectiveFileConfig().workspaces ?? [];
    this.fieldOverrides = {
      ...this.fieldOverrides,
      workspace: root,
      // 旧当前工作区也收编进列表（它此前可能只是启动参数、从未入列表），防止切走后从面板消失。
      workspaces: [...new Set([previous, ...saved, root])],
    };
    this.persistConfig();
    return { ok: true, workspace: root, workspaces: this.listWorkspaces().workspaces };
  }

  protected persistConfig(): void {
    const path =
      this.configPath ??
      join(this.displayConfig['workspace'] ?? process.cwd(), ConfigFile.FILE_NAME);
    const existing = ConfigFile.load(path);
    const merged = mergeConfigs(existing, this.fieldOverrides);
    ConfigFile.save(path, merged);
    this.configPath = path;
  }

  /** 列出工作区文件树（供 UI 左栏；防目录穿越）。 */
  protected listFs(params: Record<string, unknown>): unknown {
    const base = resolve(this.effectiveWorkspace());
    const requested = typeof params['path'] === 'string' ? params['path'] : '.';
    const maxDepth = typeof params['depth'] === 'number' ? params['depth'] : 2;
    const root = resolve(base, requested);
    if (!root.startsWith(base)) {
      throw new Error('路径越界工作区');
    }
    return { root, tree: this.scanDir(root, maxDepth, 0) };
  }

  /** 递归扫描目录（跳过隐藏项与 node_modules，限定深度）。 */
  protected scanDir(dir: string, maxDepth: number, current: number): unknown[] {
    if (current >= maxDepth || !existsSync(dir)) {
      return [];
    }
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const base = resolve(this.effectiveWorkspace());
    const out: unknown[] = [];
    for (const name of names.sort()) {
      if (name.startsWith('.') || name === 'node_modules') {
        continue;
      }
      const full = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      const rel = relative(base, full) || '.';
      const entry: Record<string, unknown> = { name, path: rel, type: isDir ? 'dir' : 'file' };
      if (isDir) {
        entry['children'] = this.scanDir(full, maxDepth, current + 1);
      }
      out.push(entry);
    }
    return out;
  }

  /** 读取工作区内文件内容（供 UI DiffBlock/代码视图；防目录穿越 + 二进制/超长截断）。 */
  protected readFs(params: Record<string, unknown>): unknown {
    // #OBS-11：复用 safeReadFile 做工作区越界校验，与 HTTP /files 路由共一套安全逻辑。
    const rel = typeof params['path'] === 'string' ? params['path'] : '';
    const r = safeReadFile(this.effectiveWorkspace(), rel);
    if (!r.ok) {
      throw new Error(r.error);
    }
    const buf = r.buffer;
    const isBinary = buf.includes(0);
    const max = typeof params['maxBytes'] === 'number' ? params['maxBytes'] : 200000;
    const content = isBinary ? '' : buf.toString('utf8').slice(0, max);
    return { path: rel, size: buf.length, isBinary, truncated: buf.length > max, content };
  }

  /** 线程结果。 */
  protected threadResult(result: {
    sessionId: string;
    finalText?: string;
    steps: number;
  }): unknown {
    return { threadId: result.sessionId, finalText: result.finalText, steps: result.steps };
  }

  /** 审批上行：发请求通知并等待响应。 */
  protected async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const requestId = id('apr');
      this.pendingApprovals.set(requestId, resolve);
      this.options.transport.send(
        JsonRpc.notify('approval.request', {
          requestId,
          toolName: request.toolName,
          target: request.target,
        }),
      );
    });
  }
}

/**
 * 服务端 no-op 监督内核：仅当启动时 `--auto-approve` 与 sandbox=passthrough 同时
 * 命中时挂上（用户在 UI 显式选了「完全访问 + 工具全部自动放行」，SupervisorKernel 的
 * fail-closed 降级会永久拦截 write_file/shell/apply_patch，与用户意图冲突）。
 * 其余配置保持原 SupervisorKernel 不动——本类只放行、模式恒 nominal，不修改生产级安全
 * 策略面。eval 端的 NoopSupervisor 在 `src/eval/evalHarness.ts`，不复用避免拉耦。
 */
class ServerNoopSupervisor implements SupervisorPort {
  report(): void {}
  mode(): SafeMode {
    return 'nominal';
  }
  snapshot(): HealthSnapshot {
    return { mode: 'nominal', entries: [], generatedAt: new Date().toISOString() };
  }
  intercept(): string | undefined {
    return undefined;
  }
  onTransition(): void {}
  attemptRecovery(): SafeMode {
    return 'nominal';
  }
}
