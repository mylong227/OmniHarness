/**
 * 桌面壳配置类型（单文件单类型集合；加载/校验见 `DesktopConfigLoader`）。
 *
 * 字段含义、合并顺序与边界见 `desktop/README.md` §4.1 与 `config/defaults.ts`。
 */

/** 窗口与外观。 */
export interface DesktopWindowConfig {
  /** 首次启动默认宽（px）。 */
  readonly width: number;
  /** 首次启动默认高（px）。 */
  readonly height: number;
  /** 最小宽（px）。 */
  readonly minWidth: number;
  /** 最小高（px）。 */
  readonly minHeight: number;
  /** 首屏背景色（#RRGGBB），避免白屏闪烁。 */
  readonly backgroundColor: string;
  /** 是否隐藏系统菜单栏（Windows/Linux）。 */
  readonly autoHideMenuBar: boolean;
  /** 窗口失焦/隐藏时是否允许 Chromium 节流（省电；流式后台刷新会变慢）。 */
  readonly backgroundThrottling: boolean;
  /** 全局「显示窗口」快捷键（Electron accelerator；空串关闭）。 */
  readonly showShortcut: string;
}

/** Harness 侧车进程与就绪协议。 */
export interface DesktopHarnessConfig {
  /** Harness 监听主机（只允许回环地址）。 */
  readonly host: string;
  /** 等待就绪文件的总超时（ms）。 */
  readonly readyTimeoutMs: number;
  /** 轮询就绪文件的间隔（ms）。 */
  readonly readyPollIntervalMs: number;
  /** `/readyz` 总超时（ms）。 */
  readonly readyzTimeoutMs: number;
  /** 单次 `/readyz` 请求超时（ms）。 */
  readonly readyzProbeTimeoutMs: number;
  /** `/readyz` 重试间隔（ms）。 */
  readonly readyzRetryIntervalMs: number;
  /** 优雅停止等待（stdin shutdown）时长（ms）。 */
  readonly stopGraceMs: number;
  /** 强杀后等待退出时长（ms），超时才树杀。 */
  readonly killGraceMs: number;
  /** 崩溃后是否自动重启 Harness。 */
  readonly autoRestart: boolean;
  /** 自动重启前的延迟（ms）。 */
  readonly restartDelayMs: number;
  /** 统计窗口内最多自动重启次数。 */
  readonly restartMax: number;
  /** 自动重启统计窗口（ms）。 */
  readonly restartWindowMs: number;
  /** 每次启动生成的 Bearer token 字节数（16–64）。 */
  readonly tokenBytes: number;
  /** 就绪文件名前缀（只含安全字符）。 */
  readonly readyFilePrefix: string;
  /** userData 下的运行目录名（就绪文件等）。 */
  readonly runDirName: string;
  /** userData 下的模型目录名。 */
  readonly modelDirName: string;
  /** userData 下的向量缓存目录名。 */
  readonly vectorDirName: string;
}

/** 自动更新。 */
export interface DesktopUpdateConfig {
  /** 启动后延迟多久自动检查（ms；0 = 不自动检查）。 */
  readonly autoCheckDelayMs: number;
  /** 发现更新后是否自动下载。 */
  readonly autoDownload: boolean;
  /** 退出时是否自动安装已下载更新。 */
  readonly autoInstallOnAppQuit: boolean;
  /** 是否允许预发布版本。 */
  readonly allowPrerelease: boolean;
  /** 更新通道（electron-updater channelName）：latest / beta / alpha。 */
  readonly channel: 'latest' | 'beta' | 'alpha';
  /** 是否允许降级到低于当前版本的构建（electron-updater allowDowngrade）。 */
  readonly allowDowngrade: boolean;
}

/** 日志。 */
export interface DesktopLoggingConfig {
  /** userData 下的日志目录名。 */
  readonly dirName: string;
  /** 内存环形缓冲行数（诊断面板读取）。 */
  readonly ringLines: number;
}

/** 原生通知文本上限。 */
export interface DesktopNotificationConfig {
  /** 标题最大字符数。 */
  readonly titleMax: number;
  /** 正文最大字符数。 */
  readonly bodyMax: number;
}

/** IPC 入参上限（渲染层不可信）。 */
export interface DesktopIpcConfig {
  /** `omni:notify` 标题上限。 */
  readonly notifyTitleMax: number;
  /** `omni:notify` 正文上限。 */
  readonly notifyBodyMax: number;
  /** `omni:notify` 会话 id 上限。 */
  readonly notifySessionIdMax: number;
}

/** 渲染层自愈（UI 加载失败 / 渲染进程崩溃的自动恢复）。 */
export interface DesktopRecoveryConfig {
  /** 统计窗口内最多自动恢复次数（加载失败与渲染崩溃各自计数；超出交人机出口）。 */
  readonly maxAttempts: number;
  /** 自动恢复统计窗口（ms）。 */
  readonly windowMs: number;
  /** 触发恢复前的延迟（ms；给瞬时故障留窗口，也让崩溃现场写完日志）。 */
  readonly delayMs: number;
}

/** 深链。 */
export interface DesktopDeepLinkConfig {
  /** 切换工作区后等待 UI 加载的上限（ms；超时也继续）。 */
  readonly uiReadyTimeoutMs: number;
}

/** CSP 指令（数组按 CSP 语法以空格连接）。 */
export interface DesktopCspConfig {
  readonly defaultSrc: readonly string[];
  readonly scriptSrc: readonly string[];
  readonly styleSrc: readonly string[];
  readonly imgSrc: readonly string[];
  readonly fontSrc: readonly string[];
  readonly connectSrc: readonly string[];
  readonly frameSrc: readonly string[];
  readonly mediaSrc: readonly string[];
  readonly baseUri: readonly string[];
  readonly formAction: readonly string[];
  readonly objectSrc: readonly string[];
  readonly frameAncestors: readonly string[];
}

/** 渲染层安全策略。 */
export interface DesktopSecurityConfig {
  /** 允许的 Web 权限（`notifications` / `clipboard-sanitized-write`）。 */
  readonly permissions: readonly string[];
  /** CSP 指令表。 */
  readonly csp: DesktopCspConfig;
}

/** 托盘。 */
export interface DesktopTrayConfig {
  /** 托盘图标边长（px）。 */
  readonly iconSize: number;
  /** 悬浮提示。 */
  readonly tooltip: string;
}

/** 桌面偏好（首次运行默认值）。 */
export interface DesktopStateConfig {
  /** 最近工作区保留条数。 */
  readonly maxRecentWorkspaces: number;
  /** 首次运行「关闭到托盘」默认值。 */
  readonly defaultCloseToTray: boolean;
  /** 首次运行「开机启动」默认值。 */
  readonly defaultOpenAtLogin: boolean;
}

/** 应用标识与外部链接。 */
export interface DesktopAppConfig {
  /** Windows AppUserModelId。 */
  readonly appId: string;
  /** 深链协议名（不含 `:`）。 */
  readonly protocol: string;
  /** 「帮助」菜单打开的仓库地址（http/https）。 */
  readonly repositoryUrl: string;
  /** 桌面壳语言：`system` 跟随系统，或固定 `zh-CN`/`en-US`。 */
  readonly language: 'system' | 'zh-CN' | 'en-US';
}

/** 桌面壳完整配置。 */
export interface DesktopConfig {
  readonly app: DesktopAppConfig;
  readonly window: DesktopWindowConfig;
  readonly harness: DesktopHarnessConfig;
  readonly update: DesktopUpdateConfig;
  readonly logging: DesktopLoggingConfig;
  readonly state: DesktopStateConfig;
  readonly notification: DesktopNotificationConfig;
  readonly ipc: DesktopIpcConfig;
  readonly deepLink: DesktopDeepLinkConfig;
  readonly recovery: DesktopRecoveryConfig;
  readonly security: DesktopSecurityConfig;
  readonly tray: DesktopTrayConfig;
}

/** 加载结果：生效配置 + 可诊断告警 + 实际读到的文件。 */
export interface LoadedDesktopConfig {
  /** 合并、校验后的配置。 */
  readonly config: DesktopConfig;
  /** 非致命告警（缺文件不告警；非法值/坏 JSON 会告警）。 */
  readonly warnings: readonly string[];
  /** 实际读取的配置文件（按优先级从低到高）。 */
  readonly sources: readonly string[];
}

/** 加载选项。 */
export interface LoadDesktopConfigOptions {
  /** 发布包/开发树内置配置路径（缺文件时用代码默认值）。 */
  readonly builtinFile?: string;
  /** 用户级覆盖路径（通常是 `userData/desktop.config.json`）。 */
  readonly userFile?: string;
  /** `OMNI_DESKTOP_CONFIG` 指定的最后一份覆盖文件。 */
  readonly envFile?: string;
}
