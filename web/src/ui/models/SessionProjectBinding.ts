// 「会话跟着项目走」的**打开前对齐**策略（从 SessionController 抽出的单职责协作者）。
//
// ## 为什么需要它（2026-10-07 用户口径）
//
// 「在 A 项目下的会话，去 B 项目打开会话，会话会自己串过来，这样是错误的」——
// 机制：路由（深链 / 前进后退 / 残留 hash）拿到 threadId 就直接加载，**既不看归属、也不切项目**，
// 于是别家项目的会话以当前项目的身份被展示，侧栏归类也跟着乱。
//
// 抽成独立类而不是留在控制器里：`SessionController` 已被编码标准门禁盯着（方法数/行数上限），
// 且这条策略本身是可独立单测的（依赖只有"取会话列表 + 切项目 + 提示"三件事）。
import type { ApiClient } from '../../core/ApiClient.js';
import type { AppHost } from '../controllers/AppController.js';
import { WorkspacePath } from './WorkspacePath.js';

/** 对齐所需的最小依赖（全部为取值器/回调，便于测试注入）。 */
export interface SessionProjectBindingDeps {
  /** RPC 客户端。 */
  readonly api: ApiClient;
  /** 状态宿主（读「当前在册会话」——服务端已按当前项目过滤）。 */
  readonly host: AppHost;
  /** 用户提示出口。 */
  readonly toast: (message: string) => void;
}

/**
 * 打开会话前的项目归属对齐。
 */
export class SessionProjectBinding {
  /**
   * 确保当前项目与该会话的归属项目一致（必要时先切项目）。
   *
   * 判定用「在册即属当前项目」：侧栏列表由服务端按当前项目过滤，列表里查得到 ⇒ 同项目，零开销直接返回；
   * 查不到才解析归属（一次 `workspace:'*'` 全量查询），归属与当前不同则先 `workspace.switch`
   * （服务端会真正重基运行时根 —— 文件根/工具根/显示根一起落到该项目，见 `AppServerBase`）。
   *
   * 归属解析失败（老会话无标记 / RPC 不可用）**不阻断打开**：保持既有行为，绝不因归类让人打不开会话。
   * @param id 目标会话 id
   * @returns 真的切换了项目时为 true（调用方据此决定是否刷新列表）
   */
  public static async ensure(deps: SessionProjectBindingDeps, id: string): Promise<boolean> {
    if (deps.host.getState().sessions.some((s) => s.id === id)) return false;
    try {
      const [all, workspaces] = await Promise.all([
        deps.api.listSessions({ includeArchived: false, workspace: '*' }),
        deps.api.listWorkspaces(),
      ]);
      const owner = all.sessions.find((s) => s.sessionId === id)?.workspace ?? '';
      const current = workspaces.current ?? '';
      if (owner === '' || WorkspacePath.same(owner, current)) return false;
      await deps.api.switchWorkspace(owner);
      deps.toast('已切到该会话所属项目：' + WorkspacePath.label(owner));
      return true;
    } catch {
      return false;
    }
  }
}
