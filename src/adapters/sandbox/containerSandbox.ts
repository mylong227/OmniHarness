import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join, relative, resolve, sep } from 'node:path';
import type { SandboxPort } from '../../ports/runtime/sandbox.ts';
import type { SandboxAction } from '../../ports/runtime/sandbox/sandboxAction.ts';
import type { SandboxDecision } from '../../ports/runtime/sandbox/sandboxDecision.ts';
import { PosixShell } from '../../util/posixShell.ts';

/** 默认镜像（推荐 Node 工具链齐备的 alpine 变体；可用 `OMNI_CONTAINER_IMAGE` 覆盖）。 */
const DEFAULT_IMAGE = 'node:22-alpine';
/** 默认内存上限（docker `--memory` 语法）。 */
const DEFAULT_MEMORY = '512m';
/** 默认进程数上限（docker `--pids-limit`）。 */
const DEFAULT_PIDS_LIMIT = 256;
/** 默认网络模式：断网（P2-2 要求「网络默认 deny」）。 */
const DEFAULT_NETWORK = 'none';
/** 探测 `docker version` 的超时（毫秒；超时即视为不可用）。 */
const PROBE_TIMEOUT_MS = 3_000;

/** 容器沙箱选项（全部可注入，便于跨平台/无 Docker 环境确定性单测）。 */
export interface ContainerSandboxOptions {
  /** 工作区根目录：唯一挂载进容器、且唯一允许读写的工作区。 */
  readonly workspaceRoot: string;
  /** 容器镜像（缺省取 `OMNI_CONTAINER_IMAGE`，再缺省 `node:22-alpine`）。 */
  readonly image?: string | undefined;
  /** 容器运行时二进制（缺省按 `OMNI_CONTAINER_BIN` → `docker` → `podman` 的顺序解析）。 */
  readonly dockerBin?: string | undefined;
  /** 可用性覆写（测试注入；缺省用 `dockerBin version --format {{.Server.Version}}` 探测）。 */
  readonly available?: boolean | undefined;
  /** 内存上限（docker `--memory` 语法，缺省 `512m`）。 */
  readonly memory?: string | undefined;
  /** 进程数上限（docker `--pids-limit`，缺省 256；须为正整数）。 */
  readonly pidsLimit?: number | undefined;
  /** 网络模式（缺省 `none` = 断网；显式改成 `bridge` 等即由调用方承担网络风险）。 */
  readonly network?: string | undefined;
}

/**
 * 容器沙箱后端（P2-2，可选档、非默认）：把命令交给 Docker / Podman 在容器内执行。
 *
 * ## 为什么是容器而不是 microVM
 *
 * 完整 microVM（Firecracker / E2B / Daytona 式快照）是重投入；Docker / Podman 是**现实可选**的
 * 隔离阶梯：容器共享宿主内核，用 namespace / cgroup / capability / 只读根文件系统建立边界。
 * 它**不是 microVM**，也不提供比「宿主内核 + 运行时」更强的边界；需要更强隔离时仍应换 microVM
 * 或独立主机。故本档**永不默认启用**，默认仍是 `policy`。
 *
 * ## 隔离语义（wrapCommand 实际施加的约束）
 *
 * - `--network none`：默认零网络（可用构造选项改成别的模式，但默认断网）；
 * - `--read-only`：容器**根文件系统只读**；唯一可写的是 `-v <workspace>:/workspace` 的 rw 绑定
 *   与 `--tmpfs /tmp`（一次性、不落盘）；
 * - `--cap-drop ALL` + `--security-opt no-new-privileges`：清空 capability 且禁止提权；
 * - `--memory` / `--pids-limit`：资源上限；
 * - `--rm --init`：退出即销毁容器，并由 init 进程回收僵尸。
 *
 * ## 诚实边界
 *
 * - **依赖外部运行时**：宿主必须安装 Docker / Podman，且守护进程可连；镜像需可拉取/已预拉取。
 *   缺任一条件即 fail-closed（`check()` 拒绝），绝不让命令静默跑回宿主；
 * - 容器只挂载 workspace：宿主其它路径在容器内不可见，故 `file_read` / `file_write` 的目标
 *   必须落在 workspace 内（词法越界直接拒绝）；
 * - workspace 以 **rw** 挂载：容器内可以删改工作区文件（这不是漏洞，是「让 agent 能干活」的
 *   代价）；`--read-only` 只保护容器根文件系统，**不保护** workspace；
 * - Windows 上依赖 Docker Desktop（含 WSL2 后端）；宿主 shell 是 `cmd.exe`，`%VAR%` 仍会被
 *   cmd 展开（与 `shell` 工具一致，属宿主 shell 语义）。
 */
export class ContainerSandbox implements SandboxPort {
  /** 适配器名（与 profile 名一致，doctor 能力表据此展示）。 */
  public readonly name = 'container';

  /** 工作区根（绝对路径；唯一挂载点与路径白名单基准）。 */
  private readonly workspaceRoot: string;
  /** 实际使用的容器运行时二进制。 */
  private readonly dockerBin: string;
  /** 实际使用的镜像。 */
  private readonly image: string;
  /** 内存上限。 */
  private readonly memory: string;
  /** 进程数上限。 */
  private readonly pidsLimit: number;
  /** 网络模式。 */
  private readonly network: string;
  /** 注入的可用性覆写（undefined = 需要真实探测）。 */
  private readonly availableOverride: boolean | undefined;
  /** 真实探测结果的进程内缓存（避免每条命令都 spawn 一次 3s 探测）。 */
  private detected: boolean | undefined;

  /**
   * @param options 容器沙箱选项（工作区、镜像、运行时、资源与网络上限）。
   * @throws Error `pidsLimit` 非正整数时抛出（配置错误不该静默变成「无上限」）。
   */
  public constructor(options: ContainerSandboxOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.image = options.image ?? ContainerSandbox.imageFromEnv();
    this.dockerBin = options.dockerBin ?? ContainerSandbox.resolveDockerBin();
    this.memory = options.memory ?? DEFAULT_MEMORY;
    this.pidsLimit = options.pidsLimit ?? DEFAULT_PIDS_LIMIT;
    this.network = options.network ?? DEFAULT_NETWORK;
    this.availableOverride = options.available;
    if (!Number.isInteger(this.pidsLimit) || this.pidsLimit <= 0) {
      throw new Error(`container 沙箱 pidsLimit 必须为正整数（当前 ${String(this.pidsLimit)}）`);
    }
  }

  /**
   * 容器运行时是否可用（缺省用真实 `version` 探测，失败/超时一律 false）。
   *
   * 探测命令是 `docker version --format '{{.Server.Version}}'`（Podman 兼容该子命令）：
   * 它能同时证明「二进制存在」与「守护进程可连」——只查 PATH 会把装了 CLI 但没起 daemon 的
   * 机器误报成可用，随后每条命令都失败。结果在进程内缓存（首次探测后不再 spawn）。
   * @returns 可用时为 true。
   */
  public available(): boolean {
    if (this.availableOverride !== undefined) {
      return this.availableOverride;
    }
    this.detected ??= ContainerSandbox.probeServer(this.dockerBin);
    return this.detected;
  }

  /**
   * 裁决动作（fail-closed：运行时不可用即拒绝一切动作）。
   *
   * 命令本身**不做**危险命令黑名单：隔离由容器承担（capability 清空、只读根、断网）。
   * 但 workspace 是 rw 挂载——危险命令仍可能删改工作区内容，需要策略时请另配 `policy`/`restricted`。
   * @param action 待裁决的沙箱动作。
   * @returns 决策结果（越界路径归 `path`，运行时不可用归 `os`）。
   */
  public async check(action: SandboxAction): Promise<SandboxDecision> {
    if (!this.available()) {
      return {
        allowed: false,
        reason:
          `容器沙箱不可用：${this.dockerBin} 未安装或守护进程未运行` +
          `（\`${this.dockerBin} version --format '{{.Server.Version}}'\` 探测失败），fail-closed。` +
          '请安装 Docker Desktop（Windows 需启用 WSL2 后端）或 podman，并确认守护进程已启动；' +
          `镜像默认 ${DEFAULT_IMAGE}，可用 OMNI_CONTAINER_IMAGE 覆盖（需可拉取或已预拉取）`,
        category: 'os',
      };
    }
    switch (action.kind) {
      case 'command':
        return {
          allowed: true,
          reason:
            `命令将在容器（${this.image}）内执行：网络模式 ${this.network}` +
            (this.network === 'none' ? '（默认断网）' : '') +
            `；根文件系统只读，仅 ${this.workspaceRoot} 以 rw 挂载到 /workspace`,
        };
      case 'file_read':
      case 'file_write':
        return this.checkPath(action);
      default:
        return {
          allowed: false,
          reason: `container 沙箱未知动作: ${String(action.kind)}`,
          category: 'other',
        };
    }
  }

  /**
   * 把 shell 命令包装成 `docker run` 调用（容器内 `sh -lc <command>`）。
   *
   * 生成形态：
   * `docker run --rm --init --network none --memory <m> --pids-limit <n> --cap-drop ALL
   *  --security-opt no-new-privileges --read-only --tmpfs /tmp -v <workspace>:/workspace
   *  -w /workspace/<rel> <image> sh -lc <quoted>`。
   *
   * 引号规则：安全字符（字母数字与 `_@+=:,./\-`）原样输出，含空格/元字符的值再按宿主 shell 加引号
   * （POSIX 单引号 `PosixShell.quote`；Windows 双引号 + `CommandLineToArgvW` 转义，因为 `cmd.exe`
   * 不认单引号分组）。容器内的 `<command>` 由容器侧 `sh` 解析：POSIX 下用单引号（内部 `'` →
   * `'\''`），Windows 下用双引号转义以穿过 `cmd.exe` / Docker CLI 的两次解析。
   * **Windows 宿主上 `%VAR%` 仍由 cmd 展开**（宿主 shell 语义，与 `shell` 工具一致；需要字面 `%`
   * 请用 `%%` 或写脚本落盘）。
   *
   * 可用性不在这里检查（本方法是纯字符串构造）：命令能否真跑由 {@link check} 前置裁决，
   * 运行时缺失时 `docker run` 自身会失败，**不会**有任何命令跑回宿主。
   *
   * @param command 原始 shell 命令文本。
   * @param cwd 命令工作目录（必须位于 workspace 内；越界即抛错，fail-closed）。
   * @param platform 平台名（缺省 `process.platform`；仅为跨平台确定性单测而暴露）。
   * @returns 可交给 ShellProcessRunner / shell 工具执行的包装命令。
   * @throws Error cwd 越界时抛出（不返回一条会读到宿主其它目录的命令）。
   */
  public wrapCommand(command: string, cwd: string, platform: string = process.platform): string {
    const workdir = ContainerSandbox.workdirFor(this.workspaceRoot, cwd);
    const argv = [
      this.dockerBin,
      'run',
      '--rm',
      '--init',
      '--network',
      this.network,
      '--memory',
      this.memory,
      '--pids-limit',
      String(this.pidsLimit),
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--read-only',
      '--tmpfs',
      '/tmp',
      '-v',
      `${this.workspaceRoot}:/workspace`,
      '-w',
      workdir,
      this.image,
      'sh',
      '-lc',
    ];
    const head = argv.map((arg) => ContainerSandbox.quoteHostArg(arg, platform)).join(' ');
    return `${head} ${ContainerSandbox.quoteInnerCommand(command, platform)}`;
  }

  /**
   * 判断目标路径是否落在 workspace 内（`resolve` 后做前缀比较；Windows 大小写不敏感）。
   *
   * 容器只 bind 挂载 workspace，宿主其它路径在容器内根本不可见；这里在**词法层**先行拒绝，
   * 是为了在进入容器前就把「注定越界」的读写动作挡掉并给出可读原因。
   * @param workspaceRoot 工作区根。
   * @param target 待判定路径（绝对路径或以 workspace 为基准的相对路径）。
   * @returns 位于 workspace 内（含根本身）时 true。
   */
  public static isInsideWorkspace(workspaceRoot: string, target: string): boolean {
    const root = resolve(workspaceRoot);
    const resolved = resolve(root, target);
    if (resolved === root) {
      return true;
    }
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    const candidate = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    const base = process.platform === 'win32' ? prefix.toLowerCase() : prefix;
    return candidate.startsWith(base);
  }

  /**
   * 把宿主 cwd 映射成容器内工作目录（`/workspace` 或 `/workspace/<rel>`，rel 用 `/` 分隔）。
   * @param workspaceRoot 工作区根。
   * @param cwd 宿主 cwd（可相对 workspace）。
   * @returns 容器内工作目录。
   * @throws Error cwd 越界时抛出（fail-closed）。
   */
  public static workdirFor(workspaceRoot: string, cwd: string): string {
    const root = resolve(workspaceRoot);
    const resolved = resolve(root, cwd);
    if (!ContainerSandbox.isInsideWorkspace(root, resolved)) {
      throw new Error(
        `容器沙箱拒绝 cwd：${cwd} 不在 workspace（${root}）内。` +
          '容器只挂载 workspace，越界目录在容器内不可用（fail-closed）',
      );
    }
    const rel = relative(root, resolved).split(sep).join('/');
    return rel === '' ? '/workspace' : `/workspace/${rel}`;
  }

  /**
   * 解析默认镜像：`OMNI_CONTAINER_IMAGE` 非空时优先，否则 `node:22-alpine`。
   * @returns 镜像名。
   */
  private static imageFromEnv(): string {
    const configured = process.env['OMNI_CONTAINER_IMAGE'];
    return configured !== undefined && configured.trim() !== '' ? configured : DEFAULT_IMAGE;
  }

  /**
   * 解析默认容器运行时：`OMNI_CONTAINER_BIN` → PATH 上的 `docker` → PATH 上的 `podman`。
   *
   * 与能力表同源（都先看 PATH 上的二进制名），使「能力表说可达」与「SandboxManager 实际构建
   * 的后端」不会一个选 docker、一个硬编码 docker 而在 podman-only 机器上互相矛盾。
   * @returns 运行时命令名（找不到任何候选时仍返回 `docker`，让后续探测给出可行动失败）。
   */
  private static resolveDockerBin(): string {
    const configured = process.env['OMNI_CONTAINER_BIN'];
    if (configured !== undefined && configured.trim() !== '') {
      return configured;
    }
    if (ContainerSandbox.commandOnPath('docker')) {
      return 'docker';
    }
    if (ContainerSandbox.commandOnPath('podman')) {
      return 'podman';
    }
    return 'docker';
  }

  /**
   * 纯文件系统命令存在性判定（不 spawn `which`：Windows 无 which，且探测不该引入额外权限面）。
   * @param command 命令名。
   * @param env 环境变量表（默认 `process.env`，读 PATH）。
   * @returns PATH 上命中时为 true。
   */
  private static commandOnPath(
    command: string,
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): boolean {
    const dirs = (env['PATH'] ?? '').split(delimiter).filter((dir) => dir !== '');
    const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
    return dirs.some((dir) =>
      suffixes.some((suffix) => existsSync(join(dir, `${command}${suffix}`))),
    );
  }

  /**
   * 真实探测守护进程（`docker version --format '{{.Server.Version}}'`，超时 3s）。
   *
   * 为什么不用 `docker --version`：那只证明 CLI 存在，不证明 daemon 可连；装了 Docker Desktop
   * 但没启动守护进程的机器会因此被误判可用，随后每条命令都失败。
   * @param bin 容器运行时二进制。
   * @returns 探测成功（退出码 0 且无 spawn 错误）时为 true。
   */
  private static probeServer(bin: string): boolean {
    try {
      const result = spawnSync(bin, ['version', '--format', '{{.Server.Version}}'], {
        timeout: PROBE_TIMEOUT_MS,
        stdio: 'ignore',
        windowsHide: true,
      });
      return result.status === 0 && result.error === undefined;
    } catch {
      return false;
    }
  }

  /**
   * 路径检查（容器内只有 workspace 可见，越界即 `path` 类拒绝）。
   * @param action 文件类动作。
   * @returns 决策结果。
   */
  private checkPath(action: SandboxAction): SandboxDecision {
    if (ContainerSandbox.isInsideWorkspace(this.workspaceRoot, action.target)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason:
        `容器沙箱只挂载 workspace（${this.workspaceRoot}）：` +
        `${action.kind} 目标越界，容器内不可见 (${action.target})`,
      category: 'path',
    };
  }

  /**
   * 引用一个宿主级参数：安全字符原样输出，其余按宿主 shell 规则加引号。
   *
   * 为什么不全量加引号：`docker run --network none ...` 的可读形态与文档一致（测试/排障可直接
   * 目视核对隔离参数）；只有路径（含空格/反斜杠）、镜像 digest 等才需要引号。安全字符集刻意收窄：
   * 空格、`$`、反引号、引号、通配符、`&|;<>()` 一律触发加引号；Windows 上 `%` 同样触发
   * （虽然 cmd 仍会展开 `%VAR%`，引号挡不住这一层宿主语义）。
   * @param value 参数原文。
   * @param platform 平台名。
   * @returns 可直接拼进命令文本的片段。
   */
  private static quoteHostArg(value: string, platform: string): string {
    if (platform === 'win32') {
      return ContainerSandbox.WINDOWS_SAFE_ARG.test(value)
        ? value
        : ContainerSandbox.quoteWindowsArg(value);
    }
    return ContainerSandbox.POSIX_SAFE_ARG.test(value) ? value : PosixShell.quote(value);
  }

  /** POSIX 宿主上无需引号的参数（空格/元字符一律排除，宁可多一层引号）。 */
  private static readonly POSIX_SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/u;
  /** Windows 宿主上无需引号的参数（不把 `%` 算安全：cmd 会展开 `%VAR%`）。 */
  private static readonly WINDOWS_SAFE_ARG = /^[A-Za-z0-9_@+=:,./\\-]+$/u;

  /**
   * 引用容器内 `sh -lc` 的命令文本（由容器侧 shell 解析）。
   * @param command 命令原文。
   * @param platform 宿主平台名（决定宿主 shell 的引号规则）。
   * @returns 可直接拼进宿主命令文本的片段。
   */
  private static quoteInnerCommand(command: string, platform: string): string {
    return platform === 'win32'
      ? ContainerSandbox.quoteWindowsArg(command)
      : PosixShell.quote(command);
  }

  /**
   * Windows argv 引号（`CommandLineToArgvW` 规则）：双引号包裹，内部 `"` 前加奇数个反斜杠，
   * 结尾反斜杠加倍——否则带尾反斜杠的路径会吃掉收尾引号。
   *
   * 为什么不能像 POSIX 那样用单引号：`cmd.exe` 不把单引号当分组符，含空格的单个参数会被拆开。
   * @param value 参数原文。
   * @returns 双引号包裹并转义后的片段。
   */
  private static quoteWindowsArg(value: string): string {
    let out = '"';
    let backslashes = 0;
    for (const char of value) {
      if (char === '\\') {
        backslashes += 1;
        continue;
      }
      if (char === '"') {
        out += `${'\\'.repeat(backslashes * 2 + 1)}"`;
        backslashes = 0;
        continue;
      }
      out += `${'\\'.repeat(backslashes)}${char}`;
      backslashes = 0;
    }
    out += `${'\\'.repeat(backslashes * 2)}"`;
    return out;
  }
}
