import { TOOL_NAMES } from '../../ports/tool/toolNames.ts';
import type {
  ApprovalDecision,
  ApprovalPort,
  ApprovalRequest,
} from '../../ports/runtime/approval.ts';
import { PLAN_ALLOWED_TOOLS } from './planApproval.ts';

/**
 * 请求批准档（ask）审批适配器。
 *
 * 档位语义（与 `ApprovalTierCatalog` 的「请求批准」描述逐字对应）：
 *   - **本地只读**工具（读文件 / 列目录 / 检索 / 记忆读 / LSP 查询等）自动放行——
 *     它们不动工作区、不联网，逐次弹框只会把用户淹没；
 *   - **其余一律询问**：编辑文件、执行命令、使用互联网（web_search / web_fetch /
 *     浏览器族）……每次都经 askHandler 等人裁决（serve 路径即上行弹框）。
 *
 * 与 `PlanApproval` 的白名单差异恰好是「互联网」两项（web_search / web_fetch）：
 * 计划模式读网页算只读，请求批准档读网页也必须问——这正是档位描述里
 * 「使用互联网时始终询问」的落点。集合从 `PLAN_ALLOWED_TOOLS` 派生而非另抄一份，
 * 防止两张白名单各自演化后漂移。
 *
 * fail-closed：askHandler 缺省时，非白名单请求一律 deny（「问不到人」绝不等于「放行」）。
 */

/** 本地只读白名单：plan 白名单去掉联网两项（联网类在请求批准档必须询问）。 */
const LOCAL_READONLY_TOOLS: ReadonlySet<string> = new Set(
  [...PLAN_ALLOWED_TOOLS].filter(
    (tool) => tool !== TOOL_NAMES.webSearch && tool !== TOOL_NAMES.webFetch,
  ),
);

/** 请求批准档审批选项。 */
export interface AskApprovalOptions {
  /**
   * 询问回调（serve 路径传上行弹框端口；CLI 无交互面时传常量应答，如 `--approval-ask`）。
   * 未提供时非白名单请求一律 deny（fail-closed）。
   */
  readonly askHandler?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
}

/** 请求批准档审批适配器：本地只读自动放行，其余一律询问。 */
export class AskApproval implements ApprovalPort {
  /**
   * 审批器标识：固定为 'ask'，用于区分「请求批准」档实现。
   */
  public readonly name = 'ask';

  /** 询问回调；未提供则非白名单一律拒绝。 */
  private readonly askHandler?:
    ((request: ApprovalRequest) => Promise<ApprovalDecision>) | undefined;

  /**
   * @param options 询问回调（缺省 fail-closed 为 deny）。
   */
  public constructor(options: AskApprovalOptions = {}) {
    this.askHandler = options.askHandler;
  }

  /** 本地只读白名单命中即放行，其余交询问回调裁决。
   * @param request 审批请求（取工具名匹配白名单，其余透传回调）。
   * @returns 白名单内 'allow'；否则回调裁决（无回调时 'deny'）。
   */
  public async decide(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (LOCAL_READONLY_TOOLS.has(request.toolName)) {
      return 'allow';
    }
    if (this.askHandler !== undefined) {
      return this.askHandler(request);
    }
    return 'deny';
  }
}
