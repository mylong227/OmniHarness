/**
 * 企业 SSO（OIDC）CLI 命令族：`auth login` / `auth callback`。
 *
 * 从 `cliServerCmds.ts` 抽出（2026-10-27：该文件被推过上帝类阈值，按纪律抽职责而非放宽）。
 * 本类零状态、只依赖注入的 `flagValue` 旗标读取器——与宿主链的唯一耦合点。
 *
 * 安全契约（2026-10-27 审计收口）：
 *  - `auth callback` 的 `--state` **必带**：此前缺省时整段 CSRF 校验被跳过（攻击者诱导
 *    受害者省略 --state 即可注入授权码）；持久化 state 就在中间态文件里，没有理由不带。
 *  - 中间态 TTL 由 `OidcClient.readAuthState` 内置（10 分钟）；本类把它的抛错转成
 *    可行动提示（此前抛错无人接住，用户看到堆栈）。
 */
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { OidcClient, type AuthState, type OidcProviderConfig } from '../enterprise/oidcClient.ts';
import { OpenIdClientFlow } from '../adapters/enterprise/openIdClientFlow.ts';
import type { OidcFlowPort } from '../ports/enterprise/oidcFlow.ts';

/** 旗标读取器签名（与 CLI 链基的 `flagValue` 一致）。 */
export type FlagValueReader = (args: readonly string[], flag: string) => string | undefined;

/** auth 命令族依赖（测试可注入替身）。 */
export interface CliAuthCmdsDeps {
  /** 旗标读取器（宿主链基的 `flagValue`）。 */
  readonly flagValue: FlagValueReader;
}

/** 企业 SSO auth 命令族。 */
export class CliAuthCmds {
  /** 旗标读取器。 */
  private readonly flagValue: FlagValueReader;

  /**
   * @param deps 依赖（旗标读取器）。
   */
  public constructor(deps: CliAuthCmdsDeps) {
    this.flagValue = deps.flagValue;
  }

  /**
   * `auth` 命令入口：分发 login / callback。
   * @param args 子命令参数（首 token 为子动作）。
   * @returns 进程退出码：子动作未知为 2，其余由子动作决定。
   */
  public async run(args: readonly string[]): Promise<number> {
    const sub = args[0];
    if (sub === 'login') return await this.runAuthLogin(args.slice(1));
    if (sub === 'callback') return await this.runAuthCallback(args.slice(1));
    process.stdout.write(
      '用法: omniharness auth login --issuer URL --client-id ID [--client-secret S] [--redirect-uri URI] [--scope S]\n' +
        '      omniharness auth callback --code C --state S\n',
    );
    return 2;
  }

  /**
   * auth login 子动作：拉取 IdP discovery、生成 PKCE 与 state、构造授权 URL，
   * 并把中间态写入 ~/.omni-auth-state.json 供 callback 续跑。
   * @param rest login 之后的参数（--issuer / --client-id 必填，--client-secret / --redirect-uri / --scope 可选）。
   * @returns 进程退出码：参数缺失为 2，discovery 拉取失败抛错，成功为 0。
   */
  private async runAuthLogin(rest: readonly string[]): Promise<number> {
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
    const nonce = crypto.randomBytes(16).toString('hex');
    const authUrl = oidcFlow.authorizationUrl(discovery, config, {
      state,
      codeChallenge: pkce.challenge,
      nonce,
    });
    const authState: AuthState = {
      issuer,
      clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri,
      scope: config.scope,
      state,
      nonce,
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
   *
   * **state 必带（2026-10-27 审计收口）**：此前 `--state` 缺省时整段校验被跳过——攻击者诱导
   * 受害者执行 `auth callback --code <攻击者code>`（省略 --state）即可注入授权码。现在
   * 缺省即拒（持久化 state 就在中间态文件里，没有理由不带）。中间态另带 **10 分钟 TTL**
   * （`OidcClient.readAuthState` 内置）：超龄/形状非法即拒并要求重登。
   * @param rest callback 之后的参数（--code 与 --state 均必填）。
   * @returns 进程退出码：缺 --code/--state 为 2，中间态缺失/过期/state 不匹配为 1，成功为 0。
   */
  private async runAuthCallback(rest: readonly string[]): Promise<number> {
    const code = this.flagValue(rest, '--code');
    if (code === undefined) {
      process.stderr.write('auth callback 需 --code\n');
      return 2;
    }
    const stateArg = this.flagValue(rest, '--state');
    if (stateArg === undefined) {
      process.stderr.write('auth callback 需 --state（auth login 输出里已给出；防 CSRF 必带）\n');
      return 2;
    }
    const statePath = join(homedir(), '.omni-auth-state.json');
    if (!existsSync(statePath)) {
      process.stderr.write(`未找到中间态文件 ${statePath}，请先执行 auth login\n`);
      return 1;
    }
    let st: ReturnType<typeof OidcClient.readAuthState>;
    try {
      st = OidcClient.readAuthState(statePath);
    } catch (error) {
      // 形状非法/超过 TTL：readAuthState 自带 10 分钟 TTL 判定（已过期/形状非法各给一条），
      // 此前该抛错无人接住，用户看到的是堆栈而不是可行动提示。
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    if (stateArg !== st.state) {
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
      expectedNonce: st.nonce,
    });
    const masked = tokens.access_token.slice(0, 6) + '…' + tokens.access_token.slice(-4);
    // 换码成功后中间态（client_secret + PKCE verifier）不再需要：立即删除，别留在 home 里等 TTL。
    try {
      rmSync(statePath, { force: true });
    } catch {
      process.stderr.write(`警告：登录成功但中间态文件未能删除：${statePath}\n`);
    }
    process.stdout.write(
      `登录成功（access_token ${masked}，token_type ${tokens.token_type}` +
        `${tokens.expires_in !== undefined ? `，有效期 ${tokens.expires_in}s` : ''}）\n` +
        `id_token ${tokens.id_token !== undefined ? '已获取' : '未返回'}\n`,
    );
    return 0;
  }
}
