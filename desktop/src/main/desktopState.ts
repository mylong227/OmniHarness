/** 桌面偏好（最近工作区/窗口/开关），原子写。 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 窗口位置与大小。 */
export interface WindowBounds {
  readonly x?: number;
  readonly y?: number;
  readonly width: number;
  readonly height: number;
}

/** 桌面偏好。 */
export interface DesktopState {
  /** 上次使用的工作区。 */
  workspace?: string;
  /** 最近工作区（新→旧）。 */
  recentWorkspaces: string[];
  /** 窗口位置/大小。 */
  window?: WindowBounds;
  /** 关闭窗口时最小化到托盘（默认 true，长任务不中断）。 */
  closeToTray?: boolean;
  /** 开机启动（默认 false）。 */
  openAtLogin?: boolean;
}

const DEFAULT_STATE: DesktopState = {
  recentWorkspaces: [],
  closeToTray: true,
  openAtLogin: false,
};
const MAX_RECENT = 8;

/** 桌面偏好存储。 */
export class DesktopStateStore {
  private readonly file: string;
  private state: DesktopState;

  /**
   * @param userDataDir Electron userData 目录。
   */
  public constructor(userDataDir: string) {
    this.file = join(userDataDir, 'desktop.json');
    this.state = DesktopStateStore.read(this.file);
  }

  /**
   * 当前状态快照。
   * @returns 状态。
   */
  public get(): DesktopState {
    return this.state;
  }

  /**
   * 记录工作区（去重、置顶、截断）。
   * @param workspace 工作区绝对路径。
   * @returns 无返回值。
   */
  public rememberWorkspace(workspace: string): void {
    const recent = [workspace, ...this.state.recentWorkspaces.filter((item) => item !== workspace)];
    this.state = { ...this.state, workspace, recentWorkspaces: recent.slice(0, MAX_RECENT) };
    this.save();
  }

  /**
   * 记录窗口位置/大小。
   * @param bounds 窗口 bounds。
   * @returns 无返回值。
   */
  public rememberWindow(bounds: WindowBounds): void {
    this.state = { ...this.state, window: bounds };
    this.save();
  }

  /**
   * 设置“关闭到托盘”。
   * @param enabled 是否启用。
   * @returns 无返回值。
   */
  public setCloseToTray(enabled: boolean): void {
    this.state = { ...this.state, closeToTray: enabled };
    this.save();
  }

  /**
   * 设置“开机启动”。
   * @param enabled 是否启用。
   * @returns 无返回值。
   */
  public setOpenAtLogin(enabled: boolean): void {
    this.state = { ...this.state, openAtLogin: enabled };
    this.save();
  }

  /**
   * 原子写入。
   * @returns 无返回值。
   */
  public save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${String(process.pid)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.file);
  }

  /**
   * 读取（脏数据/缺文件一律回落默认，不拿半条记录误导）。
   * @param file 文件路径。
   * @returns 状态。
   */
  private static read(file: string): DesktopState {
    if (!existsSync(file)) return { ...DEFAULT_STATE };
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (parsed === null || typeof parsed !== 'object') return { ...DEFAULT_STATE };
      const raw = parsed as Record<string, unknown>;
      const recent = Array.isArray(raw['recentWorkspaces'])
        ? raw['recentWorkspaces'].filter((item): item is string => typeof item === 'string')
        : [];
      const workspace = typeof raw['workspace'] === 'string' ? raw['workspace'] : undefined;
      const windowRaw = raw['window'];
      let window: WindowBounds | undefined;
      if (windowRaw !== null && typeof windowRaw === 'object') {
        const bounds = windowRaw as Record<string, unknown>;
        if (typeof bounds['width'] === 'number' && typeof bounds['height'] === 'number') {
          window = {
            width: Math.max(900, Math.round(bounds['width'])),
            height: Math.max(600, Math.round(bounds['height'])),
            ...(typeof bounds['x'] === 'number' ? { x: Math.round(bounds['x']) } : {}),
            ...(typeof bounds['y'] === 'number' ? { y: Math.round(bounds['y']) } : {}),
          };
        }
      }
      return {
        recentWorkspaces: recent.slice(0, MAX_RECENT),
        closeToTray:
          typeof raw['closeToTray'] === 'boolean' ? raw['closeToTray'] : DEFAULT_STATE.closeToTray,
        openAtLogin:
          typeof raw['openAtLogin'] === 'boolean' ? raw['openAtLogin'] : DEFAULT_STATE.openAtLogin,
        ...(workspace !== undefined ? { workspace } : {}),
        ...(window !== undefined ? { window } : {}),
      };
    } catch {
      return { ...DEFAULT_STATE };
    }
  }
}
