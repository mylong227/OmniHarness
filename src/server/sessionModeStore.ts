import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 会话级模式（UI「+」菜单里的三个开关）。
 *
 * - `goal`：持续追求的目标文本（每个回合都作为前置指令复述，直到清空）；
 * - `planMode`：计划模式（先出方案、只读工具放行，写类工具被审批层拒绝）；
 * - `sketchMode`：绘图模式（先画草图再动手，产物经 `sketch_write` 落文件）。
 */
export interface SessionModes {
  /** 目标（空串 = 未设置）。 */
  readonly goal: string;
  /** 是否处于计划模式。 */
  readonly planMode: boolean;
  /** 是否处于绘图模式。 */
  readonly sketchMode: boolean;
}

/** 未设置任何模式的初始态。 */
export const EMPTY_SESSION_MODES: SessionModes = { goal: '', planMode: false, sketchMode: false };

/** 落盘目录（相对工作区，与 `.omniharness/sessions` 同约定）。 */
const MODE_DIR = '.omniharness';

/** 落盘文件名。 */
const MODE_FILE = 'session-modes.json';

/**
 * 会话模式存储：按会话 id 持久化 `{ goal, planMode, sketchMode }`。
 *
 * 为什么按会话而不是全局：模式是**任务级**意图。把「这张图先画个草图」设成全局开关，
 * 下一个任务（改 bug）会莫名其妙地被迫先画图；反之把「目标」设成全局，切换项目后
 * 旧目标会继续背在身上。故一律以会话为界，且落盘（关页面/重启服务后仍在）。
 *
 * 容错：文件缺失/损坏 → 视为无模式；写入失败 → 抛错上抛（用户明确点了开关必须可见）。
 * 清理：会话被删除时对应条目不会自动消失，但单条 < 200 字节且键为会话 id，
 * 量级可忽略；`clear()` 提供显式清理入口。
 */
export class SessionModeStore {
  /**
   * @param workspaceRoot 当前生效工作区根（getter 注入，切换项目后自动指向新工作区）
   */
  public constructor(private readonly workspaceRoot: () => string) {}

  /**
   * 读某会话的模式。
   * @param sessionId 会话 id（空串返回空模式：无会话即无模式）
   * @returns 会话模式（字段必定有值）
   */
  public get(sessionId: string): SessionModes {
    if (sessionId === '') return EMPTY_SESSION_MODES;
    const entry = this.readAll()[sessionId];
    if (entry === null || typeof entry !== 'object') return EMPTY_SESSION_MODES;
    const raw = entry as Record<string, unknown>;
    return {
      goal: typeof raw['goal'] === 'string' ? raw['goal'] : '',
      planMode: raw['planMode'] === true,
      sketchMode: raw['sketchMode'] === true,
    };
  }

  /**
   * 局部更新某会话的模式。
   *
   * 传空串 / false 即为「清除该项」，不需要单独的 delete 语义——UI 上的开关本来就是
   * 三态（未设 / 开 / 关），用一次写入表达最直接。
   *
   * @param sessionId 会话 id（空串直接返回空模式，不落盘）
   * @param patch 待更新字段（未提供的字段保持原值）
   * @returns 更新后的会话模式
   */
  public set(sessionId: string, patch: Partial<SessionModes>): SessionModes {
    if (sessionId === '') return EMPTY_SESSION_MODES;
    const current = this.get(sessionId);
    const next: SessionModes = {
      goal: patch.goal !== undefined ? patch.goal.trim() : current.goal,
      planMode: patch.planMode !== undefined ? patch.planMode : current.planMode,
      sketchMode: patch.sketchMode !== undefined ? patch.sketchMode : current.sketchMode,
    };
    const all = this.readAll();
    if (next.goal === '' && !next.planMode && !next.sketchMode) {
      // 全空即删除条目：不给空壳条目留下无限增长的机会。
      delete all[sessionId];
    } else {
      all[sessionId] = next;
    }
    this.writeAll(all);
    return next;
  }

  /**
   * 清除某会话的全部模式。
   * @param sessionId 会话 id
   * @returns 固定为 `EMPTY_SESSION_MODES`
   */
  public clear(sessionId: string): SessionModes {
    if (sessionId === '') return EMPTY_SESSION_MODES;
    const all = this.readAll();
    if (all[sessionId] !== undefined) {
      delete all[sessionId];
      this.writeAll(all);
    }
    return EMPTY_SESSION_MODES;
  }

  /** 设置文件绝对路径。 */
  public filePath(): string {
    return join(this.workspaceRoot(), MODE_DIR, MODE_FILE);
  }

  /** 读全量映射；文件缺失/损坏返回空对象。 */
  private readAll(): Record<string, unknown> {
    const file = this.filePath();
    if (!existsSync(file)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /** 原子写全量映射（目录不存在则创建）。 */
  private writeAll(all: Record<string, unknown>): void {
    const file = this.filePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(all, null, 2) + '\n', 'utf8');
  }
}
