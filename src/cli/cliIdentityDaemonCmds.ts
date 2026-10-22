/**
 * CliIdentityDaemonCmds —— ExecCli 命令族继承链的**身份 / 后台服务层**（god-class 拆分 · 2026-10-11）。
 *
 * ## 为什么单独成层
 *
 * `serve` 加"端口冲突诊断与接管"后，`CliServerCmds` 越过编码标准的**上帝类**阈值（797 行 > 500）。
 * 处置是按职责外移（而不是放宽阈值）：本层承载两族**本地、无外部依赖**的子命令 ——
 *  · `identity`：本地 Ed25519（generate / show / sign / verify）；
 *  · `daemon`：后台服务启停与状态（pid 文件 + 树杀兜底）。
 *
 * 继承链：`CliCredentialBuild` ← `CliBuildConfig` ← **本层** ← `CliServerCmds` ← …；调用点零改动。
 */
import { DaemonController } from '../daemon/daemonController.ts';
import { Ed25519AgentIdentity } from '../adapters/identity/ed25519AgentIdentity.ts';
import { CliBuildConfig } from './cliBuildConfig.ts';
import { ArgParser, CliDefaults } from './argParser.ts';
import { ServerAuthGuard } from '../server/transport/serverAuthGuard.ts';
import { configFile } from '../config/configFile.ts';
import type { FileConfig, WorkspaceTrustOptions } from '../config/configFile.ts';

/** 身份 / 后台服务命令层。 */
export class CliIdentityDaemonCmds extends CliBuildConfig {
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
      const material = Ed25519AgentIdentity.generateAgentKeyMaterial();
      process.stdout.write(`${JSON.stringify(material)}\n`);
      return 0;
    }
    const cliArgs =
      ArgParser.parseArgs(['--prompt', 'identity-placeholder', ...args]) ?? CliDefaults;
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
    // **必须报实际绑定地址**，不能写 `localhost`：服务端默认只绑 `127.0.0.1`（`ServerAuthGuard.DEFAULT_HOST`，
    // 见其文件头"默认只绑回环"），而 Windows 上 `localhost` 常先解析到 `::1` ⇒ 用户/脚本拿到这个 URL 会
    // **间歇性拒连**（本仓 httpServer 判据踩过同一个坑：看着能用、偶发连不上，最难查的一类）。
    process.stdout.write(
      `daemon 已启动 (pid ${pid})，UI: http://${ServerAuthGuard.DEFAULT_HOST}:${port}\n`,
    );
    return 0;
  }

  /**
   * 分层加载 serve 的配置（用户级 → 项目级 → profile → bundle → 环境变量）。
   *
   * 抽成独立方法有两个原因：① `runServe` 的函数体已贴近门禁基线；② 分层顺序（尤其「用户级必须生效」）
   * 是**可单测**的行为——单测注入 `userHomedir` 即可在临时目录里造出两层配置并断言合并结果，
   * 而直接调 `runServe` 要真绑端口、真起服务，成本高且易 flake。
   *
   * **为什么必须 `loadLayered` 而不是「向上找第一份 + 单文件 load」**（2026-09-27 验收实测的缺陷）：
   * 旧写法只读**项目级那一份**，于是用户级 `~/.omniharness/omniharness.json` 里的配置
   * （`modelAdapter` / `providerKeys` / `model` / `reasoning`）被**静默忽略**——UI 上 `config.get`
   * 报 `modelAdapter: mock`，而用户明明配了真实 provider 与凭据；`dsh exec` 走的是 loadLayered
   * （`execCli.loadDefaults`），于是同一个仓库里「一次性运行用真模型、Web UI 用 mock」这种自相矛盾
   * 的表现会长期无人发现。回归见 `tests/unit/serveConfigLayering.test.ts`。
   * @param wsRoot 工作区根（项目级配置从这里向上查找）。
   * @param configPath 项目级配置路径（`--config` 显式指定或 `find` 结果）。
   * @param profile `--profile` 指定的配置 profile 名（缺省 undefined＝不叠加 profile 层）。
   * @param userHomedir 用户级配置的家目录（缺省 `os.homedir()`；测试隔离注入用）。
   * @param trust 工作区信任选项（生产入口必传；缺省保持既有合并语义）。
   * @returns 分层合并后的配置（严格校验：非法即抛 `ConfigError`，由入口 fail-closed 退出）。
   */
  public static loadServeConfig(
    wsRoot: string,
    configPath: string,
    profile?: string,
    userHomedir?: string,
    trust?: WorkspaceTrustOptions,
  ): FileConfig {
    return configFile.loadLayered({
      workspace: wsRoot,
      configPath,
      ...(profile !== undefined ? { profile } : {}),
      ...(userHomedir !== undefined ? { userHomedir } : {}),
      ...(trust !== undefined ? { trust } : {}),
    });
  }
}
