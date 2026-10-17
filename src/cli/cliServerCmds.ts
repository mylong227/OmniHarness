/**
 * cliServerCmds.ts —— ExecCli 命令簇（god-class 拆分 · 第 2/6 层）。
 *
 * 承载「服务端 / 身份 / 后台」类子命令：server / schema / doctor / auth(login|callback) /
 * identity / daemon / serve。所有方法逐字节等价于原 exec.ts，仅 `private`→`protected`。
 * 继承自 CliBuildConfig，可调用其全部共享接线与配置装配助手。
 */

import { LicenseSource } from '../license/licenseSource.ts';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { HttpBridgeTransport } from '../server/transport/httpServer.ts';
import type { HttpServer } from '../server/transport/httpServer.ts';
import { ServerAuthGuard } from '../server/transport/serverAuthGuard.ts';
import { Metrics } from '../server/services/metrics.ts';
import type { AuditSink } from '../server/services/auditSink.ts';
import type { AppServer } from '../server/core/appServer.ts';
import type { ServerEventBridge } from '../server/core/serverEventBridge.ts';
import { DoctorRunner } from './doctorRunner.ts';
import { ServeInstance } from './serveInstance.ts';
import { API_VERSION } from '../version.ts';
import {
  OidcClient,
  EnterpriseAuth,
  type OidcProviderConfig,
  type AuthState,
  type OidcDiscovery,
} from '../enterprise/index.ts';
import { OpenIdClientFlow } from '../adapters/enterprise/openIdClientFlow.ts';
import type { OidcFlowPort } from '../ports/enterprise/oidcFlow.ts';
import { CodeGenerator } from '../schema/codeGenerator.ts';
import { protocolSchema } from '../schema/protocolSchema.ts';
import { configFile } from '../config/configFile.ts';
import type { FileConfig } from '../config/configFile.ts';
import { CompositeLiveView, WebLiveView, ConsoleLiveView } from '../adapters/index.ts';
import { PluginProfileStore } from '../plugin/pluginProfileStore.ts';
import { ArgParser } from './argParser.ts';
import type { CliArgs } from './argParser.ts';
import type { ResolvedConfig } from '../ports/config/resolvedConfig.ts';
import { JoseIdTokenVerifier } from '../adapters/enterprise/joseIdTokenVerifier.ts';
import { CliArgReader } from './cliArgReader.ts';
import { ServeWorkspace } from './serveWorkspace.ts';
import { ServePortConflict } from './servePortConflict.ts';
import { CliIdentityDaemonCmds } from './cliIdentityDaemonCmds.ts';

/** 服务端 / 身份 / 后台类子命令。 */
export class CliServerCmds extends CliIdentityDaemonCmds {
  /**
   * 启动 stdio app-server（常驻，复用全部端口参数）。
   * @param serverArgs 子命令参数（经 parseArgs 全量解析为运行时配置）。
   * @returns 永不 resolve 的 Promise（常驻进程，直至外部终止）。
   */
  protected async runServer(serverArgs: readonly string[]): Promise<number> {
    const args = ArgParser.parseArgs(['--prompt', 'server', ...serverArgs]);
    if (args === undefined) {
      ArgParser.printUsage();
      return 2;
    }
    const config = await this.buildConfig(args);
    const { LineTransport } = await import('../server/transport/lineTransport.ts');
    const transport = new LineTransport(
      (onLine) => {
        const readline = createInterface({ input: process.stdin, crlfDelay: Infinity });
        readline.on('line', onLine);
      },
      (line) => process.stdout.write(`${line}\n`),
    );
    const pluginsDir =
      this.flagValue(serverArgs, '--dir') ?? join(homedir(), '.omniharness', 'plugins');
    const { AppServer } = await import('../server/core/appServer.ts');
    const app = new AppServer({
      config,
      transport,
      registry: this.createRegistry(serverArgs, pluginsDir),
      pluginsDir,
      audit: this.createAudit(serverArgs),
      workspaceRoot: process.cwd(),
      // (F4) 治理台按档位可用：权益来自本机授权（OMNI_LICENSE*）；无授权 ⇒ core 档。
      entitlements: LicenseSource.resolve({ env: process.env }),
      // Web 交付（2026-10-11）：`doctor.report` RPC 的实现由组合根注入 —— `DoctorRunner` 住在 CLI 层，
      // 而 `cli → server` 已存在，反向 import 会成环。这里注入**同一个实现**（与 `omniharness doctor`
      // 命令逐字同源），面板因此不会看到与 CLI 不一致的诊断结论。
      doctorReport: (options) => DoctorRunner.runDoctor(options ?? {}),
    });
    await app.loadPlugins();
    return new Promise(() => undefined);
  }

  /**
   * 生成 TS/Python SDK（由单源 schema）。
   * @param args 子命令参数（--out-ts / --out-py / --out-md 指定落盘路径，缺省打印到 stdout）。
   * @returns 进程退出码（当前恒为 0）。
   */
  protected async runSchema(args: readonly string[]): Promise<number> {
    const generator = new CodeGenerator();
    const tsPath = this.flagValue(args, '--out-ts');
    const pyPath = this.flagValue(args, '--out-py');
    const mdPath = this.flagValue(args, '--out-md');
    const ts = generator.generateTs(protocolSchema);
    const py = generator.generatePython(protocolSchema);
    const md = generator.generateDocs(protocolSchema);
    if (mdPath !== undefined) {
      await this.writeSdk(mdPath, md);
      process.stdout.write(`协议文档已生成: ${mdPath}\n`);
    } else if (tsPath === undefined && pyPath === undefined) {
      process.stdout.write(md);
      return 0;
    }
    if (tsPath !== undefined) {
      await this.writeSdk(tsPath, ts);
      process.stdout.write(`TS SDK 已生成: ${tsPath}\n`);
    } else {
      process.stdout.write(ts);
    }
    if (pyPath !== undefined) {
      await this.writeSdk(pyPath, py);
      process.stdout.write(`Python SDK 已生成: ${pyPath}\n`);
    } else {
      process.stdout.write(py);
    }
    return 0;
  }

  /**
   * 写 SDK 文件（自动建目录）。
   * @param filePath 目标文件路径（父目录不存在时递归创建）。
   * @param content 待写入的 UTF-8 文本。
   
   * @returns 无返回值。
   */
  protected async writeSdk(filePath: string, content: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf8');
  }

  /**
   * 环境诊断：doctor。
   * @param args 子命令参数（--config 指定待检查的配置文件路径）。
   * @returns 进程退出码：无问题为 0，存在 issue 为 1（映射见 `DoctorRunner.exitCode`，单一实现）。
   */
  protected async runDoctor(args: readonly string[]): Promise<number> {
    const configPath = this.flagValue(args, '--config');
    const report = DoctorRunner.runDoctor({ configPath });
    DoctorRunner.printDoctor(report);
    return DoctorRunner.exitCode(report);
  }

  /**
   * 企业 SSO：auth login（拉 discovery + 生成授权 URL + 持久化 state）/ auth callback（授权码换 token）。
   * @param args 子命令参数（首 token 为子动作 login / callback）。
   * @returns 进程退出码：子动作未知为 2，其余由子动作决定。
   */
  protected async runAuth(args: readonly string[]): Promise<number> {
    const sub = args[0];
    if (sub === 'login') return this.runAuthLogin(args.slice(1));
    if (sub === 'callback') return this.runAuthCallback(args.slice(1));
    process.stdout.write(
      '用法: omniharness auth login --issuer URL --client-id ID [--client-secret S] [--redirect-uri URI] [--scope S]\n' +
        '      omniharness auth callback --code C [--state S]\n',
    );
    return 2;
  }

  /**
   * auth login 子动作：拉取 IdP discovery、生成 PKCE 与 state、构造授权 URL，
   * 并把中间态写入 ~/.omni-auth-state.json 供 callback 续跑。
   * @param rest login 之后的参数（--issuer / --client-id 必填，--client-secret / --redirect-uri / --scope 可选）。
   * @returns 进程退出码：参数缺失为 2，discovery 拉取失败抛错，成功为 0。
   */
  protected async runAuthLogin(rest: readonly string[]): Promise<number> {
    const issuer = this.flagValue(rest, '--issuer');
    const clientId = this.flagValue(rest, '--client-id');
    if (issuer === undefined || clientId === undefined) {
      process.stderr.write('auth login 需 --issuer 与 --client-id\n');
      return 2;
    }
    const config: OidcProviderConfig = {
      issuer,
      clientId,
      clientSecret: this.flagValue(rest, '--client-secret'),
      redirectUri: this.flagValue(rest, '--redirect-uri'),
      scope: this.flagValue(rest, '--scope'),
    };
    // 真实拉取 discovery（需可达 IdP；本机仅做编译/单测，真实接入需目标 IdP，见 D2 说明）。
    // A.5 第四项：生产默认走第三方实现（openid-client，issuer 严格校验 + https 强制）；
    // 自研 LegacyOidcFlow 同端口保留为回退资产（差分判据见 tests/unit/oidcFlowContract.test.ts）。
    const oidcFlow: OidcFlowPort = new OpenIdClientFlow();
    const discovery = await oidcFlow.discovery(config);
    const pkce = await oidcFlow.generatePkcePair();
    const state = crypto.randomBytes(16).toString('hex');
    const authUrl = oidcFlow.authorizationUrl(discovery, config, {
      state,
      codeChallenge: pkce.challenge,
    });
    const authState: AuthState = {
      issuer,
      clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri,
      scope: config.scope,
      state,
      codeVerifier: pkce.verifier,
      createdAt: new Date().toISOString(),
    };
    const statePath = join(homedir(), '.omni-auth-state.json');
    OidcClient.writeAuthState(statePath, authState);
    process.stdout.write(
      `请在浏览器打开以下地址完成登录（登录后回调将携带 ?code=...&state=${state}）：\n\n${authUrl}\n\n` +
        `中间态已写入 ${statePath}；拿到 code 后执行：\n` +
        `  omniharness auth callback --code <CODE> --state ${state}\n`,
    );
    return 0;
  }

  /**
   * auth callback 子动作：校验 state（防 CSRF）后用授权码 + PKCE verifier 换取令牌集。
   * @param rest callback 之后的参数（--code 必填，--state 提供时必须与 login 持久化值一致）。
   * @returns 进程退出码：缺 --code 为 2，中间态缺失或 state 不匹配为 1，成功为 0。
   */
  protected async runAuthCallback(rest: readonly string[]): Promise<number> {
    const code = this.flagValue(rest, '--code');
    if (code === undefined) {
      process.stderr.write('auth callback 需 --code\n');
      return 2;
    }
    const statePath = join(homedir(), '.omni-auth-state.json');
    if (!existsSync(statePath)) {
      process.stderr.write(`未找到中间态文件 ${statePath}，请先执行 auth login\n`);
      return 1;
    }
    const st = OidcClient.readAuthState(statePath);
    const stateArg = this.flagValue(rest, '--state');
    if (stateArg !== undefined && stateArg !== st.state) {
      process.stderr.write('state 不匹配，拒绝处理（防 CSRF）\n');
      return 1;
    }
    const config: OidcProviderConfig = {
      issuer: st.issuer,
      clientId: st.clientId,
      clientSecret: st.clientSecret,
      redirectUri: st.redirectUri,
      scope: st.scope,
    };
    // A.5 第四项：与 auth login 同一默认实现（第三方 openid-client）；state 一并传入，
    // 由实现再做一次回调一致性校验（CLI 侧的比对是第一道，这里是第二道）。
    const oidcFlow: OidcFlowPort = new OpenIdClientFlow();
    const discovery = await oidcFlow.discovery(config);
    const tokens = await oidcFlow.exchangeCode(discovery, config, {
      code,
      codeVerifier: st.codeVerifier,
      redirectUri: st.redirectUri,
      state: st.state,
    });
    const masked = tokens.access_token.slice(0, 6) + '…' + tokens.access_token.slice(-4);
    process.stdout.write(
      `登录成功（access_token ${masked}，token_type ${tokens.token_type}` +
        `${tokens.expires_in !== undefined ? `，有效期 ${tokens.expires_in}s` : ''}）\n` +
        `id_token ${tokens.id_token !== undefined ? '已获取' : '未返回'}\n`,
    );
    return 0;
  }

  /**
   * 组装 serve 的「显示配置」（供 UI 展示运行口径）。
   *
   * 优先级刻意是「已落盘文件值 → CLI 传入 → 内置默认」：重启后 UI 显示必须与后端**实际所用**一致
   * （否则又会出现「UI 显示 auto、后端跑 rules」这类漂移）。抽成独立方法（并公开，供单测直接断言）
   * 的另一个原因是 `runServe` 的函数体贴近门禁基线。
   *
   * **`reasoning` 曾漏在这里**（2026-09-27 跑真 UI 时发现）：用户级配置写了 `reasoning: "high"`、
   * 后端也确实按 high 跑（`ArgParser.configDefaults` 会透传），但 UI 的「推理强度」显示「默认」——
   * 与 `modelAdapter` 那次是同一类「显示 ≠ 实际」的漂移，故一并补上。
   * @param loadedFile 分层加载后的配置（用户级 → 项目级 → profile → bundle → env 的合并结果）。
   * @param args 解析后的 CLI 参数。
   * @param wsRoot 工作区根（恒等于启动目录，见 runServe 里「工作区错位」的说明）。
   * @returns 键值表（值恒为字符串，缺失时用内置默认）。
   */
  public static displayConfigOf(
    loadedFile: FileConfig,
    args: CliArgs,
    wsRoot: string,
  ): Record<string, string> {
    return {
      modelAdapter: loadedFile.modelAdapter ?? args.modelAdapter ?? 'mock',
      model: loadedFile.model ?? args.model ?? '',
      reasoning: loadedFile.reasoning ?? args.reasoning ?? '',
      approval: loadedFile.approval ?? args.approval ?? 'rules',
      approvalAsk: args.approvalAsk ?? 'allow',
      sandbox: loadedFile.sandbox ?? args.sandbox ?? 'policy',
      escalation: loadedFile.escalation ?? args.escalation ?? 'deny',
      workspace: wsRoot,
    };
  }

  /**
   * 构造服务端鉴权门禁（`--auth-required`）。
   *
   * **为什么单独成方法**：取三个旗标 → 缺一即拒 → 组 discovery → 装校验实现，这段逻辑让 `runServe`
   * 的函数体越过铁律上限（139 > 80 且超冻结基线 132），按本仓惯例**按职责搬出**而不是放宽阈值。
   *
   * Wave A.5：鉴权热路径注入 `jose` 校验实现（多算法面 / 时钟容忍 / `azp` / 未知 kid 重取）。
   * 回退零改动：去掉第四个实参即回到本仓自研校验（同 `IdTokenVerifierPort`，两者差分已判据化）。
   * @param serveArgs serve 子命令参数
   * @returns 门禁实例；旗标缺失时返回退出码 **2**（并已写 stderr）
   */
  private enterpriseAuthOf(serveArgs: readonly string[]): EnterpriseAuth | number {
    const issuer = this.flagValue(serveArgs, '--oidc-issuer');
    const clientId = this.flagValue(serveArgs, '--oidc-client-id');
    const jwksUri = this.flagValue(serveArgs, '--oidc-jwks-uri');
    if (issuer === undefined || clientId === undefined || jwksUri === undefined) {
      process.stderr.write(
        '[auth] --auth-required 需同时提供 --oidc-issuer / --oidc-client-id / --oidc-jwks-uri（真实 IdP 的 jwks_uri 端点）\n',
      );
      return 2;
    }
    const discovery: OidcDiscovery = {
      issuer,
      authorization_endpoint: '',
      token_endpoint: '',
      jwks_uri: jwksUri,
    };
    return new EnterpriseAuth(
      { issuer, clientId },
      discovery,
      globalThis.fetch,
      new JoseIdTokenVerifier(),
    );
  }

  /**
   * serve 的上行前置装配：传输 → 指标 → 上行桥 → 配置（把**提问上行端口**注入 `userResponder`、
   * 把**工具侧事件出口**注入 `events`）。
   *
   * 为什么这几步必须绑在一起、且必须在配置构建**之前**：`ask_user` / `plan_present` 在
   * `ConfigFactory.build` 期就捕获了 `userResponder` 与事件端口（`registerAgentTools`），而提问
   * 上行端口与客户端事件出口都由本桥提供。顺序反了（或干脆不接），serve 的提问只会落到
   * `ConsoleUserResponder`（在服务端终端里问人）或 `DefaultUserResponder`（直接放弃作答）——
   * **Web 端无论哪种都答不了**；工具侧事件则会落进静默端口，UI 里连「提问」那块都看不见
   * （2026-10-08 用户报障；详见 `buildConfig` 的 `events` 覆盖说明）。
   *
   * 为什么单独成方法：`runServe` 的函数体已贴铁律上限（`check.mjs` 体量闸），按本仓惯例
   * **按职责搬出**而不是放宽阈值。
   *
   * public 而非 protected：**供单测直接断言接线**（配置里的回答器必须是本桥的提问端口，而不是
   * `ConsoleUserResponder`/`DefaultUserResponder`；事件端口必须是服务端桥，而不是静默端口）
   * ——与 `displayConfigOf` 同一取舍。
   * @param args 解析后的 CLI 参数（配置装配用；workspace 已定为启动目录）
   * @param auth 已装配的服务端鉴权门禁（undefined 表示不开鉴权）
   * @param audit 审计 sink（与本方法返回的桥共用同一实例，避免两处各自开一份）
   * @returns 传输、指标、上行桥与已注入提问端口/事件端口的解析配置
   */
  public async buildServeUpstream(
    args: CliArgs,
    auth: EnterpriseAuth | undefined,
    audit: AuditSink | undefined,
  ): Promise<{
    bridge: HttpBridgeTransport;
    metrics: Metrics;
    events: ServerEventBridge;
    config: ResolvedConfig;
  }> {
    const bridge = new HttpBridgeTransport(auth);
    const metrics = new Metrics();
    const { ServerEventBridge } = await import('../server/core/serverEventBridge.ts');
    const events = new ServerEventBridge({ transport: bridge, metrics, audit });
    const config = await this.buildConfig(args, {
      userResponder: events.questionPort(),
      // 工具侧事件也要到客户端：`ask_user` 的 `question`（对话流里那块「提问」）、`todo_write` 的
      // `todo`、`plan_write` 的 `plan` 都在 `ConfigFactory.build` 期捕获事件端口。不给这一份，
      // serve 里它们只走控制台（`args.events` 缺省 'console'）——**客户端收不到**，2026-10-08 修
      // （此前只在切换过工作区后才偶然搭上服务端端口）。
      events: events.eventPort(),
    });
    return { bridge, metrics, events, config };
  }

  /**
   * 按命名插件集 profile 收敛运行时插件集（serve 启动后的一步；G-E 5.1）。
   *
   * 为什么抽出来：runServe 的方法体已顶到铁律的 80 行上限（基线 132 行），而 Web 交付还要往
   * 构造处加注入项。处置是按职责外移这一步（自洽的一步：查 profile → 应用 → 提示/告警），
   * 而不是把上限往上挪。
   *
   * @param app 已构造的服务端。
   * @param name 插件集名（未配置时 undefined/空串 ⇒ 不做任何事）。
   * @param workspaceRoot 工作区根（profile 存储在该工作区的 .omniharness 下）。
   * @returns 无返回值。
   */
  protected async applyPluginProfile(
    app: AppServer,
    name: string | undefined,
    workspaceRoot: string,
  ): Promise<void> {
    if (name === undefined || name.length === 0) {
      return;
    }
    const store = new PluginProfileStore(workspaceRoot);
    const profile = store.get(name);
    if (profile === undefined) {
      process.stderr.write(`[warn] 未找到插件集 profile: ${name}\n`);
      return;
    }
    await app.applyPluginProfile(profile);
    process.stdout.write(`已应用插件集 profile: ${name}\n`);
  }

  /**
   * 启动 HTTP 服务；端口被占时给**可行动**的诊断，并在显式要求下接管。
   *
   * 为什么单独成方法（而不是写在 `runServe` 里）：`runServe` 的方法体已顶到铁律上限
   * （见 `applyPluginProfile` 的说明），这里再塞十几行就会越线；且"端口冲突怎么办"本身是一件事，
   * 抽出来也便于判据直接覆盖。
   *
   * 行为：
   *  · 正常绑定 ⇒ `{ok:true, port}`；
   *  · `EADDRINUSE` ⇒ 问占用者的 `/healthz`（跨平台、零依赖），把三条出路打在 stderr 上：
   *    换端口 / 停掉那个 PID / `--take-port` **显式**接管（仅当占用者确认是 OmniHarness serve）；
   *  · `--take-port` 且确认是自己人 ⇒ 终止它、等端口释放、重试一次绑定；仍失败则如实报错。
   * 其他监听错误（如 `EACCES`）原样上抛，不在这里吞。
   *
   * @param server 已构造的 HTTP 服务。
   * @param port 期望端口。
   * @param takePort 是否允许接管（`--take-port`）。
   * @returns 成功时为实际端口；失败时为可读错误与退出码。
   */
  protected async startHttpServer(
    server: HttpServer,
    port: number,
    takePort: boolean,
  ): Promise<
    { readonly ok: true; readonly port: number } | { readonly ok: false; readonly code: number }
  > {
    try {
      return { ok: true, port: await server.start(port) };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== 'EADDRINUSE') {
        throw error;
      }
      const holder = await ServePortConflict.probe(port);
      // **保留原始错误**：用户与搜索引擎认的是 `EADDRINUSE` 这个词，只打自己的建议会让人搜不到。
      // （首版只打建议，端到端判据当场要求补回。）
      process.stderr.write(
        `omniharness: 启动失败：${error instanceof Error ? error.message : String(error)}\n`,
      );
      // 实例记录（2026-10-15）：先清扫**已死**进程留下的记录（自愈），再把活着的记录交给提示。
      // 顺序不能反——否则会把一条陈旧记录当成"当前占用者的自述"印给用户。
      const recordPath = ServeInstance.pathFor(port);
      const cleaned = ServeInstance.sweep(recordPath);
      if (cleaned.swept && cleaned.record !== null) {
        process.stderr.write(
          `[omniharness] 已清理陈旧实例记录（${ServeInstance.describe(cleaned.record)}）：该进程已不在。\n`,
        );
      }
      process.stderr.write(
        `${ServePortConflict.advice(port, holder, ServeInstance.read(recordPath) ?? undefined)}\n`,
      );
      if (!takePort || holder.kind !== 'omni') {
        return { ok: false, code: 1 };
      }
      process.stderr.write(`--take-port：正在终止占用者 PID ${String(holder.pid ?? '?')}…\n`);
      if (!(await ServePortConflict.takeOver(port, holder))) {
        process.stderr.write(
          `--take-port：端口 ${String(port)} 仍被占用，已放弃（不重试第三次）。\n`,
        );
        return { ok: false, code: 1 };
      }
      try {
        return { ok: true, port: await server.start(port) };
      } catch (retryError) {
        process.stderr.write(
          `--take-port：接管后仍无法绑定端口 ${String(port)}：` +
            `${retryError instanceof Error ? retryError.message : String(retryError)}\n`,
        );
        return { ok: false, code: 1 };
      }
    }
  }

  /**
   * 启动 HTTP + SSE Web 服务（UI + JSON-RPC + 审批上行）。
   * @param serveArgs 子命令参数（--port 监听端口、--config 配置文件、--auth-required 与 --oidc-* 鉴权门禁等）。
   * @returns 永不 resolve 的 Promise（常驻进程，直至外部终止）。
   */
  protected async runServe(serveArgs: readonly string[]): Promise<number> {
    // 先预解析一次以定位工作区与配置文件（--workspace/--config 影响查找路径）。
    const preArgs = ArgParser.parseArgs(['--prompt', 'serve', ...serveArgs]);
    if (preArgs === undefined) {
      ArgParser.printUsage();
      return 2;
    }
    const wsRoot = ServeWorkspace.announceServeWorkspace(serveArgs, process.cwd());
    const explicitConfig = this.flagValue(serveArgs, '--config');
    const foundConfig =
      explicitConfig !== undefined
        ? ArgParser.toWindowsPath(explicitConfig)
        : configFile.find(wsRoot);
    if (explicitConfig === undefined && foundConfig === undefined) {
      // 旧文案说"将使用内置默认配置（mock 模型）"——**误导**（2026-10-06 实测）：用户级配置同样是
      // 合法配置层，本机实测此时仍在跑真模型（openai/deepseek），而横幅却让人以为退回了 mock。
      // 只如实说"没有项目级配置"，不再替用户断言模型。
      process.stderr.write(
        `[omniharness] 未在 ${wsRoot} 找到项目级 omniharness.json；` +
          '将只用用户级（~/.omniharness/omniharness.json）与内置默认。\n',
      );
      process.stderr.write(
        '              可在项目里放一份 omniharness.json（模板见 omniharness.json.example，' +
          '或运行 node scripts/init-config.mjs）。\n',
      );
    }
    const configPath = foundConfig ?? join(wsRoot, configFile.FILE_NAME);
    // 分层加载（用户级 → 项目级 → profile → bundle → 环境变量）；缺陷原委见 loadServeConfig 的 JSDoc。
    const loadedFile = CliServerCmds.loadServeConfig(
      wsRoot,
      configPath,
      this.flagValue(serveArgs, '--profile'),
    );
    const fileDefaults = ArgParser.configDefaults(loadedFile);
    const args = ArgParser.parseArgs(['--prompt', 'serve', ...serveArgs], fileDefaults);
    if (args === undefined) {
      ArgParser.printUsage();
      return 2;
    }
    // 修复「工作区错位」：配置文件里的 workspace 字段是 UI「当前选中工作区」的运行时状态，
    // 历史 bug 里它经 configDefaults 被合并进 args.workspace，劫持了 serve 的 workspaceRoot。
    // 例如用户曾在 UI 切到 D:\deepseek\_omni_ws，该值落盘后，下次在 omniharness 目录启动 serve
    // 时 workspaceRoot 却被 _omni_ws 覆盖 → 模型写 examples/... 报「路径越界」。
    // serve 的工作区必须恒等于启动时的真实目录（--workspace 参数 > process.cwd()），
    // 绝不从持久化的「当前工作区」状态反推。
    args.workspace = wsRoot;
    const restoreEgress = this.applyNetworkGuard(args);
    try {
      // D2 服务端鉴权门禁（opt-in，fail-closed）：开启 --auth-required 后所有 /rpc 与 /ws 调用需有效 Bearer 令牌。
      // 服务端门禁不发起授权/换码，仅需 issuer（校验 iss 声明）与 jwks_uri；开关经 CliArgReader.has 读取。
      let auth: EnterpriseAuth | undefined;
      if (new CliArgReader(serveArgs).has('--auth-required')) {
        const built = this.enterpriseAuthOf(serveArgs);
        if (typeof built === 'number') return built;
        auth = built;
      }
      const audit = this.createAudit(serveArgs);
      const upstream = await this.buildServeUpstream(args, auth, audit);
      const { bridge, metrics, events, config } = upstream;
      // serve 模式默认不启用「上行总开关」：默认档走配置的规则审批端口（安全工具自动放行，
      // 危险工具按规则裁决），避免每次都弹框；「审批」档由 config.update(approval=ask) 经
      // resolveApprovals 强制上行端口（approvalPort）显式触发弹框，与 uplink 总开关解耦。
      // 注意：**提问**不在这条总开关之下——提问不是门禁，Web 端必须能作答（见 buildServeUpstream）。
      const uplink = false;
      const displayConfig = CliServerCmds.displayConfigOf(loadedFile, args, wsRoot);
      const pluginsDir =
        this.flagValue(serveArgs, '--dir') ?? join(homedir(), '.omniharness', 'plugins');
      // #B3 web：serve 模式下，把工具参数增量实时广播给 Web UI（WebLiveView 经 bridge 推送），
      // 同时保留 ConsoleLiveView（TTY 实时刷新）；运行时其余路径不受影响。
      const live = new CompositeLiveView([new ConsoleLiveView(), new WebLiveView(bridge)]);
      const { AppServer } = await import('../server/core/appServer.ts');
      const app = new AppServer({
        config: { ...config, live },
        transport: bridge,
        // 复用同一份上行桥：`question.respond` 的处理器挂在同一个实例上，否则（各自新建）
        // 客户端作答会送到一张**没有登记过请求**的挂起表里，答案静默丢失。
        eventBridge: events,
        approvalUplink: uplink,
        metrics,
        audit,
        registry: this.createRegistry(serveArgs, pluginsDir),
        // (F4) 治理台（Pro）与审计中台（Team）按档位可用；无授权 ⇒ core 档并给可读拒因。
        entitlements: LicenseSource.resolve({ env: process.env }),
        displayConfig,
        autoApprove: serveArgs.includes('--auto-approve'),
        configPath,
        pluginsDir,
        workspaceRoot: wsRoot,
        // Web 交付（2026-10-11 修）：**stdio 路径接了 doctor，serve 路径却漏了** ——
        // 而 Web UI 连的正是 serve，于是真机上诊断面板只会回"未接线"（本地跑 stdio 却一切正常）。
        // 两条组合根必须注入同一个实现（判据 observabilityRpc.test.ts ⑥ 机械核对两处都在）。
        doctorReport: (options) => DoctorRunner.runDoctor(options ?? {}),
        // 凭据保险库（vault.list/set/delete 的后端）：无主密钥来源时不注入，面板如实显示"未接线"。
        vault: await this.buildServeVault(args),
      });
      await app.loadPlugins();
      // G-E 5.1：插件集收敛（按职责抽成方法：runServe 体量已顶到铁律上限，外移而不是放宽）。
      await this.applyPluginProfile(
        app,
        this.flagValue(serveArgs, '--plugin-profile') ?? loadedFile.pluginProfile,
        wsRoot,
      );
      // 起 HTTP 服务并常驻到退出（绑定地址/令牌、端口冲突诊断与按需接管、打印 UI 地址）。
      // 抽成方法的原因：runServe 体量顶到铁律基线（见 applyPluginProfile 的说明）。
      return await this.runHttpServe(app, bridge, metrics, serveArgs);
    } finally {
      // 退出（含 Ctrl-C / SIGTERM / 早期 return）复原全局 fetch 包装并关闭 MCP 网关子进程（补齐 serve 路径不变量）。
      restoreEgress();
      this.closeGateway();
    }
  }

  /**
   * 起 HTTP 服务并常驻到退出：算 webDir、定绑定地址与令牌、绑端口（冲突则诊断/按需接管）、打印 UI 地址。
   *
   * 为什么单独成方法：`runServe` 的方法体已顶到铁律的 80 行上限（基线 132 行）；本轮加"端口冲突
   * 诊断与接管"后又越线，故按职责外移这一自洽的收尾段（而不是把上限往上挪）。
   *
   * @param app 已构造并装好插件的服务端。
   * @param bridge 事件上行桥（HTTP 与 WS 共用）。
   * @param metrics 指标收集器。
   * @param serveArgs 子命令参数（读 `--port` / `--take-port`）。
   * @returns 进程退出码（常驻期间不返回）。
   */
  protected async runHttpServe(
    app: AppServer,
    bridge: HttpBridgeTransport,
    metrics: Metrics,
    serveArgs: readonly string[],
  ): Promise<number> {
    // 静态根：**优先 `web/dist`（Vite 构建产物），无产物时回落 `web/`（源码目录）**。
    //
    // 为什么这样解析（2026-10-17 迁移到 Vite 后的取舍）：
    //   · 前端现在是标准 Vite 项目：源码在 `web/`（index.html + src/ + styles/），
    //     构建产物在 `web/dist/`（index.html + assets/*）；
    //   · 生产/发布必须托管**产物**（源码目录里没有 assets，且不该暴露 .ts）；
    //   · 但 `npm run dev` 走 Vite dev server，此时可能没有 dist（或它是旧的），
    //     落回 `web/` 能让"直接 serve 未构建的仓库"仍然给出可解释的行为——
    //     页面会因缺 `assets/` 而白屏，但至少 index.html 能取到，便于判断"是不是没构建"。
    //
    // 判据：`tests/unit/webDirResolution.test.ts`。
    const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../web');
    const webDist = join(webRoot, 'dist');
    const webDir = existsSync(join(webDist, 'index.html')) ? webDist : webRoot;
    // 绑定地址与令牌：默认只绑回环；非回环必须配令牌（ServerAuthGuard.assertBindSafe 会在
    // start() 里拒绝裸奔启动）。两者都可用环境变量覆盖，避免动 CLI 旗标表。
    const serveHost =
      (process.env[ServerAuthGuard.HOST_ENV] ?? '').trim() || ServerAuthGuard.DEFAULT_HOST;
    const serveToken = (process.env[ServerAuthGuard.TOKEN_ENV] ?? '').trim() || undefined;
    ServerAuthGuard.assertBindSafe(serveHost, serveToken);
    const { HttpServer } = await import('../server/transport/httpServer.ts');
    const server = new HttpServer({
      app,
      bridge,
      webDir,
      metrics,
      workspaceRoot: () => app.effectiveWorkspace(),
      host: serveHost,
      authToken: serveToken,
    });
    const port = this.flagNumber(serveArgs, '--port') ?? 8787;
    // 启动即清扫本端口的**陈旧**实例记录（进程已不在 ⇒ 删掉并如实说明）：
    // 这是"陈旧实例可识别"的自愈面——记录不会长期撒谎，也不会在下次冲突提示里冒充当前占用者。
    const stale = ServeInstance.sweep(ServeInstance.pathFor(port));
    if (stale.swept && stale.record !== null) {
      process.stderr.write(
        `[omniharness] 已清理陈旧实例记录（${ServeInstance.describe(stale.record)}）：该进程已不在。\n`,
      );
    }
    const binding = await this.startHttpServer(server, port, serveArgs.includes('--take-port'));
    if (binding.ok !== true) {
      return binding.code;
    }
    // 绑定成功后才写记录（先写会留下"说要跑但没跑起来"的假记录）。
    const instancePath = ServeInstance.announce({
      pid: process.pid,
      host: serveHost,
      port: binding.port,
      startedAt: new Date().toISOString(),
      workspace: app.effectiveWorkspace(),
      version: API_VERSION,
    });
    const authNote =
      serveToken === undefined ? '（未启用鉴权；仅回环可访问）' : '（已启用 Bearer 鉴权）';
    process.stdout.write(`OmniHarness UI: http://${serveHost}:${binding.port} ${authNote}\n`);
    return CliServerCmds.awaitShutdown(server, instancePath);
  }

  /**
   * 关闭 MCP 网关子进程（若已连接）：serve / exec 路径退出时由 finally 调用，避免网关子进程残留占端口。
   * 声明为 protected，使继承链下游（execCli 等）可直接复用，不重复定义成员。
   * @returns 无返回值。
   */
  protected closeGateway(): void {
    this.gateway?.close();
    this.gateway = undefined;
  }

  /**
   * 常驻等待信号并**优雅收尾**（2026-09-26 审计 S5）。
   *
   * 原实现 `return new Promise(() => undefined)` 且不注册任何信号处理 —— Ctrl-C / SIGTERM 时
   * 监听套接字、WS/SSE 客户端、MCP/LSP/Chrome/后台作业子进程全部不被关闭，端口要等进程被强杀
   * 才释放（Windows 上孙进程还可能残留）。
   * @param server 已启动的 HTTP 服务。
   * @param instancePath 本实例的记录文件路径（收尾时**只删自己的**那条记录）。
   * @returns 关闭完成后 resolve（调用方据此正常退出）。
   */
  private static awaitShutdown(server: HttpServer, instancePath: string): Promise<number> {
    return new Promise<number>((resolve) => {
      const shutdown = (signal: NodeJS.Signals): void => {
        process.stdout.write(`\n收到 ${signal}，正在关闭服务…\n`);
        void server
          .close()
          .catch(() => undefined)
          .finally(() => {
            // 正常退出即退役记录；异常退出留下的记录由下次启动清扫（见 `ServeInstance.sweep`）。
            ServeInstance.retire(instancePath);
            resolve(0);
          });
      };
      process.once('SIGINT', () => shutdown('SIGINT'));
      process.once('SIGTERM', () => shutdown('SIGTERM'));
    });
  }
}
