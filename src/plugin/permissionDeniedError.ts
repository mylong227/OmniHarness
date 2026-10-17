import type { PluginPermission } from './permission.ts';
import { OmniError, ErrorCode } from '../omniError.ts';

export class PermissionDeniedError extends OmniError {
  public constructor(
    public readonly pluginName: string,
    public readonly missing: readonly PluginPermission[],
  ) {
    super(
      ErrorCode.PERMISSION_DENIED,
      `插件 "${pluginName}" 权限未在白名单内，已拒绝: ${missing.join(', ')}`,
    );
  }
}
