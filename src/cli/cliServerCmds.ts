/**
 * cliServerCmds.ts —— ExecCli 命令簇（god-class 拆分 · 第 2/6 层）。
 *
 * 承载「服务端 / 身份 / 后台」类子命令：server / schema / doctor / auth(login|callback) /
 * identity / daemon / serve。所有方法逐字节等价于原 exec.ts，仅 `private`→`protected`。
 * 继承自 CliBuildConfig，可调用其全部共享接线与配置装配助手。
 */

import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { LineTransport } from '../server/lineTransport.js';
import { HttpServer, HttpBridgeTransport } from '../server/httpServer.js';
import { Metrics } from '../server/metrics.js';
import { AppServer } from '../server/appServer.js';
import { runDoctor as runDoctorReport, printDoctor } from './doctorRunner.js';
import {
  fetchDiscovery,
  generatePkcePair,
  buildAuthorizationUrl,
  exchangeCode,
  writeAuthState,
  readAuthState,
  EnterpriseAuth,
  type OidcProviderConfig,
  type AuthState,
  type OidcDiscovery,
} from '../enterprise/index.js';
import { CodeGenerator } from '../schema/codeGenerator.js';
import { protocolSchema } from '../schema/protocolSchema.js';
import {
  Ed25519AgentIdentity,
  generateAgentKeyMaterial,
} from '../adapters/identity/ed25519AgentIdentity.js';
import { DaemonController } from '../daemon/daemonController.js';
import { configFile } from '../config/configFile.js';
import { CompositeLiveView, WebLiveView, ConsoleLiveView } from '../adapters/index.js';
import { PluginProfileStore } from '../plugin/pluginProfileStore.js';
import { parseArgs, printUsage, toWindowsPath, CliDefaults, configDefaults } from './argParser.js';
import { CliBuildConfig } from './cliBuildConfig.js';

/** 服务端 / 身份 / 后台类子命令。 */
export class CliServerCmds extends CliBuildConfig {
  /**
   * 启动 stdio app-server（常驻，复用全部端口参数）。
   * @param serverArgs 子命令参数（经 parseArgs 全量解析为运行时配置）。
   * @returns 永不 resolve 的 Promise（常驻进程，直至外部终止）。
   */
  protected async runServer(serverArgs: readonly string[]): Promise<number> {
    const args = parseArgs(['--prompt', 'server', ...serverArgs]);
    if (args === undefined) {
      printUsage();
      return 2;
    }
    const config = await this.buildConfig(args);
    const transport = new LineTransport(
      (onLine) => {
        const readline = createInterface({ input: process.stdin, crlfDelay: Infinity });
        readline.on('line', onLine);
      },
      (line) => process.stdout.write(`${line}\n`),
    );
    const pluginsDir =
      this.flagValue(serverArgs, '--dir') ?? join(homedir(), '.omniharness', 'plugins');
    const app = new AppServer({
      config,
      transport,
      registry: this.createRegistry(serverArgs, pluginsDir),
      pluginsDir,
      audit: this.createAudit(serverArgs),
      workspaceRoot: process.cwd(),
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
   * @returns 进程退出码：无问题为 0，存在 issue 为 1。
   */
  protected async runDoctor(args: readonly string[]): Promise<number> {
    const configPath = this.flagValue(args, '--config');
    const report = runDoctorReport({ configPath });
    printDoctor(report);
    return report.issues.length === 0 ? 0 : 1;
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
    const discovery = await fetchDiscovery(issuer);
    const pkce = generatePkcePair();
    const state = crypto.randomBytes(16).toString('hex');
    const authUrl = buildAuthorizationUrl(discovery, config, {
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
    writeAuthState(statePath, authState);
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
    const st = readAuthState(statePath);
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
    const discovery = await fetchDiscovery(st.issuer);
    const tokens = await exchangeCode(discovery, config, {
      code,
      codeVerifier: st.codeVerifier,
      redirectUri: st.redirectUri,
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
   * Agent 密码学身份（#S33）：generate/show/sign/verify，本地 Ed25519，零外部依赖。
   * @param args 子命令参数（首 token 为子动作，--private-key / --payload / --signature 按动作取用）。
   * @returns 进程退出码：子动作未知或身份未配置为 2/1，验签失败为 1，成功为 0。
   */
  protected async runIdentity(args: readonly string[]): Promise<number> {
    const sub = args[0];
    if (sub !== 'generate' && sub !== 'show' && sub !== 'sign' && sub !== 'verify') {
      process.stdout.write(
        '用法: omniharness identity <generate|show|sign|verify> [--private-key PKCS8_B64] [--runtime-id ID] [--payload STR] [--signature B64]\n',
      );
      return 2;
    }
    if (sub === 'generate') {
      const material = generateAgentKeyMaterial();
      process.stdout.write(`${JSON.stringify(material)}\n`);
      return 0;
    }
    const cliArgs = parseArgs(['--prompt', 'identity-placeholder', ...args]) ?? CliDefaults;
    const config = await this.buildConfig(cliArgs);
    const privateKey = this.flagValue(args, '--private-key');
    const runtimeId = this.flagValue(args, '--runtime-id');
    const identity =
      config.identity ??
      (privateKey !== undefined
        ? new Ed25519AgentIdentity({ privateKeyPkcs8Base64: privateKey, agentRuntimeId: runtimeId })
        : undefined);
    if (identity === undefined) {
      process.stdout.write(
        'identity 未配置：用 --private-key PKCS8_B64 指定密钥，或在配置中声明 agentIdentity\n',
      );
      return 1;
    }
    if (sub === 'show') {
      process.stdout.write(
        `${JSON.stringify({ agent_runtime_id: identity.runtimeId(), public_key_ssh: identity.publicKeySsh() })}\n`,
      );
      return 0;
    }
    const payload = this.flagValue(args, '--payload') ?? '';
    if (sub === 'sign') {
      process.stdout.write(`${JSON.stringify({ signature: identity.sign(payload) })}\n`);
      return 0;
    }
    const signature = this.flagValue(args, '--signature') ?? '';
    const valid = identity.verify(payload, signature);
    process.stdout.write(`${JSON.stringify({ valid })}\n`);
    return valid ? 0 : 1;
  }

  /**
   * daemon start|stop|status：常驻后台 serve（PID 文件管理，多会话由 serve 承接）。
   * @param daemonArgs 子命令参数（首 token 为子动作 stop / status，缺省视为 start；start 支持 --port 与透传 serve 的参数）。
   * @returns 进程退出码（各分支恒为 0）。
   */
  protected async runDaemon(daemonArgs: readonly string[]): Promise<number> {
    const controller = new DaemonController();
    const sub = daemonArgs[0];
    if (sub === 'stop') {
      const ok = controller.stop();
      process.stdout.write(ok ? 'daemon 已停止\n' : 'daemon 未运行\n');
      return 0;
    }
    if (sub === 'status') {
      const st = controller.status();
      process.stdout.write(st.running ? `daemon 运行中 (pid ${st.pid})\n` : 'daemon 未运行\n');
      return 0;
    }
    // 默认 start：解析 --port 与透传给 serve 的参数。
    const rest = daemonArgs.slice(1);
    let port = 8787;
    const serveArgs: string[] = [];
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === '--port') {
        const p = Number.parseInt(rest[i + 1] ?? '', 10);
        if (!Number.isNaN(p)) port = p;
        i += 1;
      } else {
        serveArgs.push(rest[i] ?? '');
      }
    }
    const pid = controller.start(serveArgs, port);
    process.stdout.write(`daemon 已启动 (pid ${pid})，UI: http://localhost:${port}\n`);
    return 0;
  }

  /**
   * 启动 HTTP + SSE Web 服务（UI + JSON-RPC + 审批上行）。
   * @param serveArgs 子命令参数（--port 监听端口、--config 配置文件、--auth-required 与 --oidc-* 鉴权门禁等）。
   * @returns 永不 resolve 的 Promise（常驻进程，直至外部终止）。
   */
  protected async runServe(serveArgs: readonly string[]): Promise<number> {
    // 先预解析一次以定位工作区与配置文件（--workspace/--config 影响查找路径）。
    const preArgs = parseArgs(['--prompt', 'serve', ...serveArgs]);
    if (preArgs === undefined) {
      printUsage();
      return 2;
    }
    const wsRoot = toWindowsPath(preArgs.workspace ?? process.cwd());
    const explicitConfig = this.flagValue(serveArgs, '--config');
    const foundConfig =
      explicitConfig !== undefined ? toWindowsPath(explicitConfig) : configFile.find(wsRoot);
    if (explicitConfig === undefined && foundConfig === undefined) {
      process.stderr.write(
        '[omniharness] 未找到 omniharness.json，serve 将使用内置默认配置（mock 模型）。\n',
      );
      process.stderr.write(
        '              可复制 omniharness.json.example，或运行 node scripts/init-config.mjs 生成。\n',
      );
    }
    const configPath = foundConfig ?? join(wsRoot, configFile.FILE_NAME);
    // 加载项目配置文件后，把其中字段作为 CLI 默认值：这样 serve 启动时后端实际运行配置
    // 与文件内容一致（如 approval=auto），不再出现 UI 显示 auto 后端却用 rules 的漂移。
    const loadedFile = configFile.load(configPath);
    const fileDefaults = configDefaults(loadedFile);
    const args = parseArgs(['--prompt', 'serve', ...serveArgs], fileDefaults);
    if (args === undefined) {
      printUsage();
      return 2;
    }
    // 修复「工作区错位」：配置文件里的 workspace 字段是 UI「当前选中工作区」的运行时状态，
    // 历史 bug 里它经 configDefaults 被合并进 args.workspace，劫持了 serve 的 workspaceRoot。
    // 例如用户曾在 UI 切到 D:\deepseek\_omni_ws，该值落盘后，下次在 omniharness 目录启动 serve
    // 时 workspaceRoot 却被 _omni_ws 覆盖 → 模型写 examples/... 报「路径越界」。
    // serve 的工作区必须恒等于启动时的真实目录（--workspace 参数 > process.cwd()），
    // 绝不从持久化的「当前工作区」状态反推。
    args.workspace = wsRoot;
    this.applyNetworkGuard(args);
    const config = await this.buildConfig(args);
    // D2 服务端鉴权门禁（opt-in，fail-closed）：开启 --auth-required 后所有 /rpc 与 /ws 调用需有效 Bearer 令牌。
    // 服务端门禁不发起授权/换码，仅需 issuer（校验令牌 iss 声明）与 jwks_uri（拉取公钥校验 RS256 签名）。
    let auth: EnterpriseAuth | undefined;
    if (serveArgs.includes('--auth-required')) {
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
      auth = new EnterpriseAuth({ issuer, clientId }, discovery);
    }
    const bridge = new HttpBridgeTransport(auth);
    const metrics = new Metrics();
    // serve 模式默认不启用「上行总开关」：默认档走配置的规则审批端口（安全工具自动放行，
    // 危险工具按规则裁决），避免每次都弹框；「审批」档由 config.update(approval=ask) 经
    // resolveApprovals 强制上行端口（approvalPort）显式触发弹框，与 uplink 总开关解耦。
    const uplink = false;
    // 重启后 UI 显示优先取已落盘文件值，再回退 CLI 传入，再回退内置默认，保证「所见即运行时所用」。
    const displayConfig: Record<string, string> = {
      modelAdapter: loadedFile.modelAdapter ?? args.modelAdapter ?? 'mock',
      model: loadedFile.model ?? args.model ?? '',
      approval: loadedFile.approval ?? args.approval ?? 'rules',
      approvalAsk: args.approvalAsk ?? 'allow',
      sandbox: loadedFile.sandbox ?? args.sandbox ?? 'policy',
      escalation: loadedFile.escalation ?? args.escalation ?? 'deny',
      workspace: wsRoot,
    };
    const pluginsDir =
      this.flagValue(serveArgs, '--dir') ?? join(homedir(), '.omniharness', 'plugins');
    // #B3 web：serve 模式下，把工具参数增量实时广播给 Web UI（WebLiveView 经 bridge 推送），
    // 同时保留 ConsoleLiveView（TTY 实时刷新）；运行时其余路径不受影响。
    const live = new CompositeLiveView([new ConsoleLiveView(), new WebLiveView(bridge)]);
    const app = new AppServer({
      config: { ...config, live },
      transport: bridge,
      approvalUplink: uplink,
      metrics,
      audit: this.createAudit(serveArgs),
      registry: this.createRegistry(serveArgs, pluginsDir),
      displayConfig,
      autoApprove: serveArgs.includes('--auto-approve'),
      configPath,
      pluginsDir,
      workspaceRoot: wsRoot,
    });
    await app.loadPlugins();
    // G-E 5.1：启动后若指定插件集 profile，把运行时插件集收敛为该命名组合。
    const pluginProfileName =
      this.flagValue(serveArgs, '--plugin-profile') ?? loadedFile.pluginProfile ?? undefined;
    if (pluginProfileName !== undefined && pluginProfileName.length > 0) {
      const store = new PluginProfileStore(wsRoot);
      const profile = store.get(pluginProfileName);
      if (profile === undefined) {
        process.stderr.write(`[warn] 未找到插件集 profile: ${pluginProfileName}\n`);
      } else {
        await app.applyPluginProfile(profile);
        process.stdout.write(`已应用插件集 profile: ${pluginProfileName}\n`);
      }
    }
    const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../web');
    const server = new HttpServer({
      app,
      bridge,
      webDir,
      metrics,
      workspaceRoot: () => app.effectiveWorkspace(),
    });
    const port = this.flagNumber(serveArgs, '--port') ?? 8787;
    const actual = await server.start(port);
    process.stdout.write(`OmniHarness UI: http://localhost:${actual}\n`);
    return new Promise(() => undefined);
  }
}
