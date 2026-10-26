/**
 * 桌面配置加载器（单类；逐字段校验/夹取，绝不静默采纳非法值）。
 *
 * 合并顺序：`DEFAULT_DESKTOP_CONFIG` → 内置/发布包 → 用户 → `OMNI_DESKTOP_CONFIG`。
 * 本文件不 import electron，可在 `node --test` 里直接跑。
 */
import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_DESKTOP_CONFIG } from './defaults.ts';
import type {
  DesktopAppConfig,
  DesktopConfig,
  DesktopCspConfig,
  DesktopDeepLinkConfig,
  DesktopHarnessConfig,
  DesktopIpcConfig,
  DesktopLoggingConfig,
  DesktopNotificationConfig,
  DesktopSecurityConfig,
  DesktopStateConfig,
  DesktopTrayConfig,
  DesktopUpdateConfig,
  DesktopWindowConfig,
  LoadDesktopConfigOptions,
  LoadedDesktopConfig,
} from './types.ts';

/** 校验上下文：收集告警（不抛错）。 */
interface Validator {
  warn(path: string, message: string): void;
}

/** 允许的 Web 权限。 */
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  'notifications',
  'clipboard-sanitized-write',
]);

/** 桌面配置加载器。 */
export class DesktopConfigLoader {
  /**
   * 加载并逐字段合并配置。
   * @param options 三份文件路径（均可缺省）。
   * @returns 生效配置、告警与实际来源。
   */
  public static load(options: LoadDesktopConfigOptions = {}): LoadedDesktopConfig {
    const warnings: string[] = [];
    const sources: string[] = [];
    const v: Validator = { warn: (path, message) => warnings.push(`${path}: ${message}`) };
    let config: DesktopConfig = structuredClone(DEFAULT_DESKTOP_CONFIG);

    const builtin = DesktopConfigLoader.readConfigFile(
      options.builtinFile,
      false,
      warnings,
      sources,
    );
    if (builtin !== undefined) config = DesktopConfigLoader.applyDocument(config, builtin, v);

    const user = DesktopConfigLoader.readConfigFile(options.userFile, false, warnings, sources);
    if (user !== undefined) config = DesktopConfigLoader.applyDocument(config, user, v);

    const env = DesktopConfigLoader.readConfigFile(options.envFile, true, warnings, sources);
    if (env !== undefined) config = DesktopConfigLoader.applyDocument(config, env, v);

    return { config, warnings, sources };
  }

  /** 读一份 JSON（容忍 BOM；坏文件只告警）。 */
  private static readConfigFile(
    file: string | undefined,
    required: boolean,
    warnings: string[],
    sources: string[],
  ): Record<string, unknown> | undefined {
    if (file === undefined || file === '') return undefined;
    if (!existsSync(file)) {
      if (required) warnings.push(`${file}: 文件不存在，已忽略`);
      return undefined;
    }
    try {
      const text = readFileSync(file, 'utf8').replace(/^\uFEFF/u, '');
      const parsed = JSON.parse(text) as unknown;
      if (!DesktopConfigLoader.isRecord(parsed)) {
        warnings.push(`${file}: 顶层必须是对象，已忽略`);
        return undefined;
      }
      sources.push(file);
      return parsed;
    } catch (error) {
      warnings.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /** 对象判定。 */
  private static isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  /** 取一个配置分区；非对象 -> 空对象 + 告警。 */
  private static section(
    doc: Record<string, unknown>,
    name: string,
    v: Validator,
  ): Record<string, unknown> {
    const value = doc[name];
    if (value === undefined) return {};
    if (!DesktopConfigLoader.isRecord(value)) {
      v.warn(name, '应为对象，已忽略');
      return {};
    }
    return value;
  }

  /** 合并全部分区（未知字段忽略）。 */
  private static applyDocument(
    base: DesktopConfig,
    doc: Record<string, unknown>,
    v: Validator,
  ): DesktopConfig {
    return {
      app: DesktopConfigLoader.mergeApp(DesktopConfigLoader.section(doc, 'app', v), base.app, v),
      window: DesktopConfigLoader.mergeWindow(
        DesktopConfigLoader.section(doc, 'window', v),
        base.window,
        v,
      ),
      harness: DesktopConfigLoader.mergeHarness(
        DesktopConfigLoader.section(doc, 'harness', v),
        base.harness,
        v,
      ),
      update: DesktopConfigLoader.mergeUpdate(
        DesktopConfigLoader.section(doc, 'update', v),
        base.update,
        v,
      ),
      logging: DesktopConfigLoader.mergeLogging(
        DesktopConfigLoader.section(doc, 'logging', v),
        base.logging,
        v,
      ),
      state: DesktopConfigLoader.mergeState(
        DesktopConfigLoader.section(doc, 'state', v),
        base.state,
        v,
      ),
      notification: DesktopConfigLoader.mergeNotification(
        DesktopConfigLoader.section(doc, 'notification', v),
        base.notification,
        v,
      ),
      ipc: DesktopConfigLoader.mergeIpc(DesktopConfigLoader.section(doc, 'ipc', v), base.ipc, v),
      deepLink: DesktopConfigLoader.mergeDeepLink(
        DesktopConfigLoader.section(doc, 'deepLink', v),
        base.deepLink,
        v,
      ),
      security: DesktopConfigLoader.mergeSecurity(
        DesktopConfigLoader.section(doc, 'security', v),
        base.security,
        v,
      ),
      tray: DesktopConfigLoader.mergeTray(
        DesktopConfigLoader.section(doc, 'tray', v),
        base.tray,
        v,
      ),
    };
  }

  /** 数字：类型错回落；越界夹取。 */
  private static numberField(
    value: unknown,
    fallback: number,
    min: number,
    max: number,
    path: string,
    v: Validator,
  ): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      v.warn(path, `应为数字，实际 ${JSON.stringify(value)}，回落 ${String(fallback)}`);
      return fallback;
    }
    if (value < min || value > max) {
      const clamped = Math.min(max, Math.max(min, value));
      v.warn(
        path,
        `越界 ${String(value)}，夹取为 ${String(clamped)}（允许 ${String(min)}–${String(max)}）`,
      );
      return clamped;
    }
    return value;
  }

  /** 整数：在 numberField 上取整。 */
  private static integerField(
    value: unknown,
    fallback: number,
    min: number,
    max: number,
    path: string,
    v: Validator,
  ): number {
    const numeric = DesktopConfigLoader.numberField(value, fallback, min, max, path, v);
    return Math.round(numeric);
  }

  /** 布尔：类型错回落。 */
  private static booleanField(
    value: unknown,
    fallback: boolean,
    path: string,
    v: Validator,
  ): boolean {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') {
      v.warn(path, `应为布尔，实际 ${JSON.stringify(value)}，回落 ${String(fallback)}`);
      return fallback;
    }
    return value;
  }

  /** 字符串：正则不匹配回落。 */
  private static stringField(
    value: unknown,
    fallback: string,
    pattern: RegExp,
    path: string,
    v: Validator,
  ): string {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !pattern.test(value)) {
      v.warn(path, `形状非法，回落 ${JSON.stringify(fallback)}`);
      return fallback;
    }
    return value;
  }

  /** 枚举：白名单之外回落。 */
  private static enumField<T extends string>(
    value: unknown,
    fallback: T,
    allowed: readonly T[],
    path: string,
    v: Validator,
  ): T {
    if (value === undefined) return fallback;
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
      return value as T;
    }
    v.warn(
      path,
      `应为 ${allowed.join(' / ')} 之一，实际 ${JSON.stringify(value)}，回落 ${fallback}`,
    );
    return fallback;
  }

  /** 回环主机：serve 固定绑 127.0.0.1。 */
  private static loopbackField(
    value: unknown,
    fallback: string,
    path: string,
    v: Validator,
  ): string {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || value !== '127.0.0.1') {
      v.warn(path, '只允许 127.0.0.1（serve 固定绑回环；当前不支持 --host）');
      return fallback;
    }
    return value;
  }

  /** CSP token 列表：过滤控制字符/分号，非法项告警。 */
  private static cspTokens(
    value: unknown,
    path: string,
    v: Validator,
  ): readonly string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
      v.warn(path, '应为字符串数组，回落默认值');
      return undefined;
    }
    const tokens: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string' || item === '') {
        v.warn(path, `忽略非字符串项 ${JSON.stringify(item)}`);
        continue;
      }
      if (item.includes(';') || /[\r\n]/u.test(item)) {
        v.warn(path, `忽略含 ; 或换行的 token ${JSON.stringify(item)}`);
        continue;
      }
      tokens.push(item);
    }
    return tokens;
  }

  /** app 分区。 */
  private static mergeApp(
    raw: Record<string, unknown>,
    base: DesktopAppConfig,
    v: Validator,
  ): DesktopAppConfig {
    return {
      appId: DesktopConfigLoader.stringField(
        raw['appId'],
        base.appId,
        /^[A-Za-z0-9._-]{1,128}$/u,
        'app.appId',
        v,
      ),
      protocol: DesktopConfigLoader.stringField(
        raw['protocol'],
        base.protocol,
        /^[a-z][a-z0-9+.-]{1,31}$/u,
        'app.protocol',
        v,
      ),
      repositoryUrl: DesktopConfigLoader.stringField(
        raw['repositoryUrl'],
        base.repositoryUrl,
        /^https?:\/\/[^\s]+$/u,
        'app.repositoryUrl',
        v,
      ),
      language: DesktopConfigLoader.enumField(
        raw['language'],
        base.language,
        ['system', 'zh-CN', 'en-US'] as const,
        'app.language',
        v,
      ),
    };
  }

  /** window 分区。 */
  private static mergeWindow(
    raw: Record<string, unknown>,
    base: DesktopWindowConfig,
    v: Validator,
  ): DesktopWindowConfig {
    return {
      width: DesktopConfigLoader.integerField(
        raw['width'],
        base.width,
        640,
        4096,
        'window.width',
        v,
      ),
      height: DesktopConfigLoader.integerField(
        raw['height'],
        base.height,
        480,
        2160,
        'window.height',
        v,
      ),
      minWidth: DesktopConfigLoader.integerField(
        raw['minWidth'],
        base.minWidth,
        640,
        4096,
        'window.minWidth',
        v,
      ),
      minHeight: DesktopConfigLoader.integerField(
        raw['minHeight'],
        base.minHeight,
        480,
        2160,
        'window.minHeight',
        v,
      ),
      backgroundColor: DesktopConfigLoader.stringField(
        raw['backgroundColor'],
        base.backgroundColor,
        /^#[0-9a-fA-F]{6}$/u,
        'window.backgroundColor',
        v,
      ),
      autoHideMenuBar: DesktopConfigLoader.booleanField(
        raw['autoHideMenuBar'],
        base.autoHideMenuBar,
        'window.autoHideMenuBar',
        v,
      ),
      backgroundThrottling: DesktopConfigLoader.booleanField(
        raw['backgroundThrottling'],
        base.backgroundThrottling,
        'window.backgroundThrottling',
        v,
      ),
      showShortcut: DesktopConfigLoader.stringField(
        raw['showShortcut'],
        base.showShortcut,
        /^(?:[A-Za-z0-9+]|CommandOrControl|Command|Control|Ctrl|Alt|Shift|Super|Meta|Space|F(?:[1-9]|1[0-2])){0,64}$/u,
        'window.showShortcut',
        v,
      ),
    };
  }

  /** harness 分区。 */
  private static mergeHarness(
    raw: Record<string, unknown>,
    base: DesktopHarnessConfig,
    v: Validator,
  ): DesktopHarnessConfig {
    return {
      host: DesktopConfigLoader.loopbackField(raw['host'], base.host, 'harness.host', v),
      readyTimeoutMs: DesktopConfigLoader.integerField(
        raw['readyTimeoutMs'],
        base.readyTimeoutMs,
        1_000,
        120_000,
        'harness.readyTimeoutMs',
        v,
      ),
      readyPollIntervalMs: DesktopConfigLoader.integerField(
        raw['readyPollIntervalMs'],
        base.readyPollIntervalMs,
        10,
        5_000,
        'harness.readyPollIntervalMs',
        v,
      ),
      readyzTimeoutMs: DesktopConfigLoader.integerField(
        raw['readyzTimeoutMs'],
        base.readyzTimeoutMs,
        1_000,
        60_000,
        'harness.readyzTimeoutMs',
        v,
      ),
      readyzProbeTimeoutMs: DesktopConfigLoader.integerField(
        raw['readyzProbeTimeoutMs'],
        base.readyzProbeTimeoutMs,
        100,
        30_000,
        'harness.readyzProbeTimeoutMs',
        v,
      ),
      readyzRetryIntervalMs: DesktopConfigLoader.integerField(
        raw['readyzRetryIntervalMs'],
        base.readyzRetryIntervalMs,
        10,
        5_000,
        'harness.readyzRetryIntervalMs',
        v,
      ),
      stopGraceMs: DesktopConfigLoader.integerField(
        raw['stopGraceMs'],
        base.stopGraceMs,
        1_000,
        60_000,
        'harness.stopGraceMs',
        v,
      ),
      killGraceMs: DesktopConfigLoader.integerField(
        raw['killGraceMs'],
        base.killGraceMs,
        500,
        30_000,
        'harness.killGraceMs',
        v,
      ),
      autoRestart: DesktopConfigLoader.booleanField(
        raw['autoRestart'],
        base.autoRestart,
        'harness.autoRestart',
        v,
      ),
      restartDelayMs: DesktopConfigLoader.integerField(
        raw['restartDelayMs'],
        base.restartDelayMs,
        0,
        30_000,
        'harness.restartDelayMs',
        v,
      ),
      restartMax: DesktopConfigLoader.integerField(
        raw['restartMax'],
        base.restartMax,
        1,
        10,
        'harness.restartMax',
        v,
      ),
      restartWindowMs: DesktopConfigLoader.integerField(
        raw['restartWindowMs'],
        base.restartWindowMs,
        10_000,
        3_600_000,
        'harness.restartWindowMs',
        v,
      ),
      tokenBytes: DesktopConfigLoader.integerField(
        raw['tokenBytes'],
        base.tokenBytes,
        16,
        64,
        'harness.tokenBytes',
        v,
      ),
      readyFilePrefix: DesktopConfigLoader.stringField(
        raw['readyFilePrefix'],
        base.readyFilePrefix,
        /^[A-Za-z0-9_-]{1,32}$/u,
        'harness.readyFilePrefix',
        v,
      ),
      runDirName: DesktopConfigLoader.stringField(
        raw['runDirName'],
        base.runDirName,
        /^[A-Za-z0-9._-]{1,64}$/u,
        'harness.runDirName',
        v,
      ),
      modelDirName: DesktopConfigLoader.stringField(
        raw['modelDirName'],
        base.modelDirName,
        /^[A-Za-z0-9._-]{1,64}$/u,
        'harness.modelDirName',
        v,
      ),
      vectorDirName: DesktopConfigLoader.stringField(
        raw['vectorDirName'],
        base.vectorDirName,
        /^[A-Za-z0-9._-]{1,64}$/u,
        'harness.vectorDirName',
        v,
      ),
    };
  }

  /** update 分区。 */
  private static mergeUpdate(
    raw: Record<string, unknown>,
    base: DesktopUpdateConfig,
    v: Validator,
  ): DesktopUpdateConfig {
    return {
      autoCheckDelayMs: DesktopConfigLoader.integerField(
        raw['autoCheckDelayMs'],
        base.autoCheckDelayMs,
        0,
        3_600_000,
        'update.autoCheckDelayMs',
        v,
      ),
      autoDownload: DesktopConfigLoader.booleanField(
        raw['autoDownload'],
        base.autoDownload,
        'update.autoDownload',
        v,
      ),
      autoInstallOnAppQuit: DesktopConfigLoader.booleanField(
        raw['autoInstallOnAppQuit'],
        base.autoInstallOnAppQuit,
        'update.autoInstallOnAppQuit',
        v,
      ),
      allowPrerelease: DesktopConfigLoader.booleanField(
        raw['allowPrerelease'],
        base.allowPrerelease,
        'update.allowPrerelease',
        v,
      ),
      channel: DesktopConfigLoader.enumField(
        raw['channel'],
        base.channel,
        ['latest', 'beta', 'alpha'] as const,
        'update.channel',
        v,
      ),
      allowDowngrade: DesktopConfigLoader.booleanField(
        raw['allowDowngrade'],
        base.allowDowngrade,
        'update.allowDowngrade',
        v,
      ),
    };
  }

  /** logging 分区。 */
  private static mergeLogging(
    raw: Record<string, unknown>,
    base: DesktopLoggingConfig,
    v: Validator,
  ): DesktopLoggingConfig {
    return {
      dirName: DesktopConfigLoader.stringField(
        raw['dirName'],
        base.dirName,
        /^[A-Za-z0-9._-]{1,64}$/u,
        'logging.dirName',
        v,
      ),
      ringLines: DesktopConfigLoader.integerField(
        raw['ringLines'],
        base.ringLines,
        20,
        10_000,
        'logging.ringLines',
        v,
      ),
    };
  }

  /** state 分区。 */
  private static mergeState(
    raw: Record<string, unknown>,
    base: DesktopStateConfig,
    v: Validator,
  ): DesktopStateConfig {
    return {
      maxRecentWorkspaces: DesktopConfigLoader.integerField(
        raw['maxRecentWorkspaces'],
        base.maxRecentWorkspaces,
        1,
        50,
        'state.maxRecentWorkspaces',
        v,
      ),
      defaultCloseToTray: DesktopConfigLoader.booleanField(
        raw['defaultCloseToTray'],
        base.defaultCloseToTray,
        'state.defaultCloseToTray',
        v,
      ),
      defaultOpenAtLogin: DesktopConfigLoader.booleanField(
        raw['defaultOpenAtLogin'],
        base.defaultOpenAtLogin,
        'state.defaultOpenAtLogin',
        v,
      ),
    };
  }

  /** notification 分区。 */
  private static mergeNotification(
    raw: Record<string, unknown>,
    base: DesktopNotificationConfig,
    v: Validator,
  ): DesktopNotificationConfig {
    return {
      titleMax: DesktopConfigLoader.integerField(
        raw['titleMax'],
        base.titleMax,
        16,
        1_000,
        'notification.titleMax',
        v,
      ),
      bodyMax: DesktopConfigLoader.integerField(
        raw['bodyMax'],
        base.bodyMax,
        16,
        1_000,
        'notification.bodyMax',
        v,
      ),
    };
  }

  /** ipc 分区。 */
  private static mergeIpc(
    raw: Record<string, unknown>,
    base: DesktopIpcConfig,
    v: Validator,
  ): DesktopIpcConfig {
    return {
      notifyTitleMax: DesktopConfigLoader.integerField(
        raw['notifyTitleMax'],
        base.notifyTitleMax,
        16,
        2_000,
        'ipc.notifyTitleMax',
        v,
      ),
      notifyBodyMax: DesktopConfigLoader.integerField(
        raw['notifyBodyMax'],
        base.notifyBodyMax,
        16,
        8_000,
        'ipc.notifyBodyMax',
        v,
      ),
      notifySessionIdMax: DesktopConfigLoader.integerField(
        raw['notifySessionIdMax'],
        base.notifySessionIdMax,
        16,
        1_000,
        'ipc.notifySessionIdMax',
        v,
      ),
    };
  }

  /** deepLink 分区。 */
  private static mergeDeepLink(
    raw: Record<string, unknown>,
    base: DesktopDeepLinkConfig,
    v: Validator,
  ): DesktopDeepLinkConfig {
    return {
      uiReadyTimeoutMs: DesktopConfigLoader.integerField(
        raw['uiReadyTimeoutMs'],
        base.uiReadyTimeoutMs,
        0,
        60_000,
        'deepLink.uiReadyTimeoutMs',
        v,
      ),
    };
  }

  /** security 分区（权限白名单 + CSP token 校验）。 */
  private static mergeSecurity(
    raw: Record<string, unknown>,
    base: DesktopSecurityConfig,
    v: Validator,
  ): DesktopSecurityConfig {
    let permissions: readonly string[] = base.permissions;
    if (raw['permissions'] !== undefined) {
      if (!Array.isArray(raw['permissions'])) {
        v.warn('security.permissions', '应为字符串数组，回落默认值');
      } else {
        const kept = raw['permissions'].filter((item): item is string => {
          if (typeof item !== 'string') return false;
          if (ALLOWED_PERMISSIONS.has(item)) return true;
          v.warn('security.permissions', `未知权限 ${JSON.stringify(item)}，已剔除`);
          return false;
        });
        permissions = kept;
      }
    }
    const cspRaw = raw['csp'];
    const cspDoc = DesktopConfigLoader.isRecord(cspRaw)
      ? cspRaw
      : cspRaw === undefined
        ? {}
        : (v.warn('security.csp', '应为对象，回落默认值'), {});
    return { permissions, csp: DesktopConfigLoader.mergeCsp(cspDoc, base.csp, v) };
  }

  /** CSP 分区（逐指令过滤 token）。 */
  private static mergeCsp(
    raw: Record<string, unknown>,
    base: DesktopCspConfig,
    v: Validator,
  ): DesktopCspConfig {
    const directive = (key: keyof DesktopCspConfig): readonly string[] =>
      DesktopConfigLoader.cspTokens(raw[key], `security.csp.${key}`, v) ?? base[key];
    return {
      defaultSrc: directive('defaultSrc'),
      scriptSrc: directive('scriptSrc'),
      styleSrc: directive('styleSrc'),
      imgSrc: directive('imgSrc'),
      fontSrc: directive('fontSrc'),
      connectSrc: directive('connectSrc'),
      frameSrc: directive('frameSrc'),
      mediaSrc: directive('mediaSrc'),
      baseUri: directive('baseUri'),
      formAction: directive('formAction'),
      objectSrc: directive('objectSrc'),
      frameAncestors: directive('frameAncestors'),
    };
  }

  /** tray 分区。 */
  private static mergeTray(
    raw: Record<string, unknown>,
    base: DesktopTrayConfig,
    v: Validator,
  ): DesktopTrayConfig {
    return {
      iconSize: DesktopConfigLoader.integerField(
        raw['iconSize'],
        base.iconSize,
        8,
        64,
        'tray.iconSize',
        v,
      ),
      tooltip: DesktopConfigLoader.stringField(
        raw['tooltip'],
        base.tooltip,
        /^.{1,100}$/u,
        'tray.tooltip',
        v,
      ),
    };
  }
}
