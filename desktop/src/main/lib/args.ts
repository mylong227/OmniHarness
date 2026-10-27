/** 命令行参数解析（纯函数，便于单测）。 */

/** 启动参数解析结果。 */
export interface LaunchArgs {
  /** `--workspace` 指定的工作区（未指定为 null）。 */
  readonly workspace: string | null;
  /** `--hidden`：启动到托盘/后台（当前仅记录，窗口仍会显示）。 */
  readonly hidden: boolean;
  /** `omniharness://` 深链（交给 `DeepLinkRouter`：workspace 切换 / UI 聚焦）。 */
  readonly deepLink: string | null;
}

/**
 * 从 argv 解析启动参数。
 * @param argv 进程参数（含 exe/入口前缀）。
 * @param protocol 深链协议名（缺省 `omniharness`，由桌面配置传入）。
 * @returns 解析结果。
 */
export function parseLaunchArgs(argv: readonly string[], protocol = 'omniharness'): LaunchArgs {
  const deepLinkPrefix = `${protocol}://`;
  let workspace: string | null = null;
  let hidden = false;
  let deepLink: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) continue;
    if (value === '--workspace') {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('-')) {
        workspace = next;
        index += 1;
      }
      continue;
    }
    if (value.startsWith('--workspace=')) {
      const inline = value.slice('--workspace='.length);
      if (inline !== '') workspace = inline;
      continue;
    }
    if (value === '--hidden') {
      hidden = true;
      continue;
    }
    if (value.startsWith(deepLinkPrefix)) {
      deepLink = value;
    }
  }
  return { workspace, hidden, deepLink };
}
