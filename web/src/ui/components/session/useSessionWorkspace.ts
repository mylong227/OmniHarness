// 工作区（当前项目路径 / 项目清单 / 内嵌目录选择器 / 文件树）状态与动作。
//
// 从 SessionPanel 抽出（2026-11 长函数拆分）：面板原来把 6 个 state + 2 个 effect + 6 个
// 动作全塞在组件体里。这里按「取数（两个 effect）→ 动作（两个工厂）」分层，动作只写 state、
// 不读 state 快照（当前路径由参数传入），因此每次渲染重建动作对象不改变行为。
//
// 取数口径保持不变：
//   · `listWorkspaces` 挂载时一次，**项目身份变化（workspaceEpoch）时再来一次**——打开别家
//     项目的会话会隐式切项目，不重取的话侧栏项目名 / 面包屑 / 文件树都停在旧项目；
//   · `listFs` 随当前路径变化重取（原 componentDidUpdate 的 prevState.wsPath 比对）。

import * as React from 'react';
import { desktopBridge } from '../../../core/desktop/DesktopBridge.ts';
import type { ApiClient } from '../../../core/ApiClient.ts';
import type { ToastKind } from '../../../core/ToastService.ts';
import type { FsNode } from '../../../types/models.ts';
import { t } from '../../i18n/i18n.ts';

/** Toast 签名（与 AppContext 的 toast 一致）。 */
type Toast = (message: string, kind?: ToastKind) => void;

/** 工作区 state 写入器（动作只写这些，不读 state 快照）。 */
interface WorkspaceSetters {
  readonly setWsPath: (path: string) => void;
  readonly setProjects: (list: string[]) => void;
  readonly setPicking: (open: boolean) => void;
  readonly setTreeLoaded: (loaded: boolean) => void;
  readonly setTreeError: (message: string | null) => void;
}

/** 工作区动作的依赖。 */
interface WorkspaceOpsDeps extends WorkspaceSetters {
  readonly api: ApiClient;
  readonly toast: Toast;
  /** 当前工作区路径（同路径短路、归入当前项目都用它）。 */
  readonly wsPath: string;
  /** 新建会话（在项目内新建线程用）。 */
  readonly onNew: () => void;
  /** 关闭顶部项目菜单。 */
  readonly closeWsMenu: () => void;
  readonly onWorkspaceResolved?: ((path: string) => void) | undefined;
  readonly onWorkspaceSwitched?: (() => void) | undefined;
}

/** 切换类动作。 */
interface WorkspaceSwitchOps {
  readonly switchProject: (path: string) => Promise<boolean>;
  readonly newThreadInProject: (path: string) => Promise<void>;
  readonly pickProject: (path: string) => Promise<void>;
}

/** 其它项目动作。 */
interface ProjectOps {
  readonly addProject: () => void;
  readonly cancelPicker: () => void;
  readonly assignToCurrentProject: (sessionId: string) => Promise<void>;
  readonly revealProject: (path: string) => void;
}

/**
 * 切换 / 添加 / 在项目内新建：三条路径都要「让某条路径成为当前工作区」。
 * @param d 依赖（api / toast / 当前路径 / 回调 / state 写入器）
 * @returns 切换类动作
 */
function makeWorkspaceSwitcher(d: WorkspaceOpsDeps): WorkspaceSwitchOps {
  /** 让路径成为当前工作区（项目名 / 面包屑 / 文件树一起换）。 */
  const applyWorkspace = (path: string): void => {
    d.setWsPath(path);
    d.setTreeLoaded(false);
    d.setTreeError(null);
    d.onWorkspaceResolved?.(path);
  };

  /** 切换项目：服务端重建运行时后刷新文件树；同路径直接短路，不打断用户。 */
  const switchProject = async (path: string): Promise<boolean> => {
    if (path === d.wsPath) return true;
    try {
      await d.api.switchWorkspace(path);
      applyWorkspace(path);
      d.onWorkspaceSwitched?.();
      return true;
    } catch (e) {
      d.toast(t('切换失败：{msg}', { msg: (e as Error).message }), 'err');
      return false;
    }
  };

  /** 在指定项目开新线程：跨项目时先切项目，失败则不新建。 */
  const newThreadInProject = async (path: string): Promise<void> => {
    d.closeWsMenu();
    if (await switchProject(path)) d.onNew();
  };

  /** 选中目录：加入项目列表并立即切换过去（会话归它管，文件树随之刷新）。 */
  const pickProject = async (path: string): Promise<void> => {
    d.setPicking(false);
    try {
      const res = await d.api.addWorkspace(path);
      d.setProjects(res.workspaces);
      await d.api.switchWorkspace(path);
      applyWorkspace(path);
      d.onWorkspaceSwitched?.();
    } catch (e) {
      d.toast(t('添加失败：{msg}', { msg: (e as Error).message }), 'err');
    }
  };

  return { switchProject, newThreadInProject, pickProject };
}

/**
 * 归入当前项目 / 打开项目目录 / 打开目录选择器。
 * @param d 依赖（api / toast / 当前路径 / 回调 / state 写入器）
 * @returns 项目动作
 */
function makeProjectOps(d: WorkspaceOpsDeps): ProjectOps {
  /** 打开内嵌文件夹选择器。 */
  const addProject = (): void => d.setPicking(true);

  /** 关闭内嵌文件夹选择器。 */
  const cancelPicker = (): void => d.setPicking(false);

  /**
   * 把某条会话**归入当前项目**（右键菜单项；服务端只改首行 `session_meta.workspace`）。
   * 给「没有归属标记」的历史会话一个指认入口，指认后归入当前项目组，侧栏不再有孤儿行。
   */
  const assignToCurrentProject = async (sessionId: string): Promise<void> => {
    if (d.wsPath === '') {
      d.toast(t('当前项目未知，无法归入'), 'err');
      return;
    }
    try {
      await d.api.setSessionWorkspace(sessionId, d.wsPath);
      d.toast(t('已归入当前项目'));
      d.onWorkspaceSwitched?.();
    } catch (e) {
      d.toast(t('归入失败：{msg}', { msg: (e as Error).message }), 'err');
    }
  };

  /** 在系统文件管理器中打开项目目录（仅桌面版）。 */
  const revealProject = (path: string): void => {
    const bridge = desktopBridge();
    if (bridge === null) {
      d.toast(t('仅桌面版支持打开项目目录'), 'err');
      return;
    }
    void bridge.revealPath(path).catch((e: unknown) => {
      d.toast(t('打开项目目录失败：{msg}', { msg: (e as Error).message }), 'err');
    });
  };

  return { addProject, cancelPicker, assignToCurrentProject, revealProject };
}

/** useSessionWorkspace 的依赖。 */
export interface SessionWorkspaceDeps {
  readonly api: ApiClient;
  readonly toast: Toast;
  /** 项目身份代数（变化即重取项目清单）。 */
  readonly workspaceEpoch?: number | undefined;
  readonly onNew: () => void;
  readonly onWorkspaceResolved?: ((path: string) => void) | undefined;
  readonly onWorkspaceSwitched?: (() => void) | undefined;
  /** 关闭顶部项目菜单（新线程 / 添加项目走的那条路）。 */
  readonly closeWsMenu: () => void;
}

/** 工作区状态与动作。 */
export interface SessionWorkspaceApi extends WorkspaceSwitchOps, ProjectOps {
  /** 当前工作区路径（空串 = 尚未解析出来）。 */
  readonly wsPath: string;
  /** 已添加的项目路径清单。 */
  readonly projects: string[];
  /** 内嵌目录选择器是否打开。 */
  readonly picking: boolean;
  /** 文件树。 */
  readonly tree: FsNode[];
  /** 文件树是否已加载完成。 */
  readonly treeLoaded: boolean;
  /** 文件树错误信息（非空即不可用）。 */
  readonly treeError: string | null;
}

/**
 * 工作区状态与动作（项目清单 + 当前路径 + 文件树 + 选择器 + 六个动作）。
 * @param deps ApiClient、toast、项目代数与宿主回调
 * @returns 工作区状态与动作
 */
export function useSessionWorkspace(deps: SessionWorkspaceDeps): SessionWorkspaceApi {
  const { api, toast, workspaceEpoch, onNew, onWorkspaceResolved, onWorkspaceSwitched, closeWsMenu } = deps;
  const [wsPath, setWsPath] = React.useState<string>('');
  const [projects, setProjects] = React.useState<string[]>([]);
  const [picking, setPicking] = React.useState<boolean>(false);
  const [tree, setTree] = React.useState<FsNode[]>([]);
  const [treeLoaded, setTreeLoaded] = React.useState<boolean>(false);
  const [treeError, setTreeError] = React.useState<string | null>(null);

  // 拉取工作区清单（当前路径 + 已添加项目）：挂载时一次，**项目身份变化时再来一次**。
  React.useEffect(() => {
    api
      .listWorkspaces()
      .then((r) => {
        setWsPath(r.current);
        setProjects(r.workspaces);
        if (typeof r.current === 'string' && r.current !== '') onWorkspaceResolved?.(r.current);
      })
      .catch(() => {
        /* 静默：分组标题退化为通用名 */
      });
  }, [api, onWorkspaceResolved, workspaceEpoch]);

  // 工作区变化即重刷文件树；alive 防迟到回写（组件已卸载 / 路径已换）。
  React.useEffect(() => {
    let alive = true;
    api
      .listFs(3)
      .then((r) => {
        if (alive) {
          setTree(r.tree || []);
          setTreeLoaded(true);
          setTreeError(null);
        }
      })
      .catch(() => {
        if (alive) {
          setTreeError(t('文件树不可用'));
          setTreeLoaded(true);
        }
      });
    return () => {
      alive = false;
    };
  }, [api, wsPath]);

  const opsDeps: WorkspaceOpsDeps = {
    api,
    toast,
    wsPath,
    onNew,
    closeWsMenu,
    onWorkspaceResolved,
    onWorkspaceSwitched,
    setWsPath,
    setProjects,
    setPicking,
    setTreeLoaded,
    setTreeError,
  };
  return {
    wsPath,
    projects,
    picking,
    tree,
    treeLoaded,
    treeError,
    ...makeWorkspaceSwitcher(opsDeps),
    ...makeProjectOps(opsDeps),
  };
}
