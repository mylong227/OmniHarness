import { isAbsolute } from 'node:path';
import type { ApprovalDecision } from '../ports/runtime/approval.ts';
import { AcpRequestError } from './acpRequestError.ts';
import type { AcpPermissionOutcome, AcpStopReason } from './acpProtocol.ts';
import type { AcpRunResult } from './agentAcpSession.ts';
import { ACP_ERROR_INVALID_PARAMS } from './acpProtocol.ts';

/**
 * ACP 请求参数校验与结果映射（2026-10-24 从 `AcpServer` 拆出：降低单类成员数）。
 *
 * 纯函数式静态方法，不持有状态；调用点只做 `AcpValidation.xxx(...)`。
 */
export class AcpValidation {
  /**
   * 校验并返回绝对路径 cwd。
   * @param record 请求参数对象。
   * @returns cwd。
   */
  public static requireAbsoluteCwd(record: Record<string, unknown>): string {
    const cwd = AcpValidation.requireString(record, 'cwd');
    if (!isAbsolute(cwd)) {
      throw new AcpRequestError(`cwd 必须是绝对路径: ${cwd}`, ACP_ERROR_INVALID_PARAMS);
    }
    return cwd;
  }

  /**
   * 校验可选的绝对路径 cwd（缺省 / null 返回 undefined）。
   * @param record 请求参数对象。
   * @returns cwd 或 undefined。
   */
  public static optionalAbsoluteCwd(record: Record<string, unknown>): string | undefined {
    const value = record['cwd'];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || !isAbsolute(value)) {
      throw new AcpRequestError(`cwd 必须是绝对路径: ${String(value)}`, ACP_ERROR_INVALID_PARAMS);
    }
    return value;
  }

  /**
   * 取必填字符串字段。
   * @param record 请求参数对象。
   * @param key 字段名。
   * @returns 字段值。
   */
  public static requireString(record: Record<string, unknown>, key: string): string {
    const value = record[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new AcpRequestError(`缺少必填字段: ${key}`, ACP_ERROR_INVALID_PARAMS);
    }
    return value;
  }

  /**
   * 把 prompt 内容块拼接为纯文本（resource 内嵌文本会并入；image/audio 明确拒绝）。
   * @param value 原始 prompt 值。
   * @returns 拼接后的文本（非空）。
   */
  public static promptTextOf(value: unknown): string {
    if (!Array.isArray(value)) {
      throw new AcpRequestError('prompt 必须是内容块数组', ACP_ERROR_INVALID_PARAMS);
    }
    const parts: string[] = [];
    for (const block of value) {
      const record = AcpValidation.recordOf(block);
      const type = record['type'];
      if (type === 'text' && typeof record['text'] === 'string') {
        parts.push(record['text']);
        continue;
      }
      if (type === 'resource_link' && typeof record['uri'] === 'string') {
        const name = typeof record['name'] === 'string' ? record['name'] : record['uri'];
        parts.push(`${name}: ${record['uri']}`);
        continue;
      }
      if (type === 'resource') {
        const resource = AcpValidation.recordOf(record['resource']);
        if (typeof resource['text'] === 'string') parts.push(resource['text']);
        continue;
      }
      if (type === 'image' || type === 'audio') {
        throw new AcpRequestError(
          `prompt 含不支持的内容类型: ${type}（能力未声明）`,
          ACP_ERROR_INVALID_PARAMS,
        );
      }
    }
    const text = parts.join('\n').trim();
    if (text === '') {
      throw new AcpRequestError('prompt 缺少文本内容', ACP_ERROR_INVALID_PARAMS);
    }
    return text;
  }

  /**
   * 由取消标记与运行结果推导 ACP 结束原因。
   * @param cancelled 本轮是否收到过取消。
   * @param result 运行结果。
   * @returns stopReason。
   */
  public static stopReasonOf(cancelled: boolean, result: AcpRunResult): AcpStopReason {
    if (cancelled || result.aborted) return 'cancelled';
    if (result.truncated) return 'max_turn_requests';
    return 'end_turn';
  }

  /**
   * 权限结果 → 审批决策（allow 系列放行；reject 系列与 cancelled 拒绝）。
   * @param outcome 权限结果。
   * @returns allow / deny。
   */
  public static decisionOf(outcome: AcpPermissionOutcome): ApprovalDecision {
    if (outcome.outcome === 'selected') {
      return outcome.optionId.startsWith('allow') ? 'allow' : 'deny';
    }
    return 'deny';
  }

  /**
   * 权限结果是否落在「总是允许 / 总是拒绝」选项上（决定是否写入会话级记忆）。
   * @param outcome 权限结果。
   * @returns 命中 always 选项为 true。
   */
  public static isAlwaysOption(outcome: AcpPermissionOutcome): boolean {
    return (
      outcome.outcome === 'selected' &&
      (outcome.optionId === 'allow-always' || outcome.optionId === 'reject-always')
    );
  }

  /**
   * 归一为普通对象（非对象/数组返回空对象）。
   * @param value 待判值。
   * @returns 普通对象。
   */
  public static recordOf(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
}
