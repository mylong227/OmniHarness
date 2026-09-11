import { OmniError, ErrorCode } from '../../omniError.js';

export class EgressBlockedError extends OmniError {
  /** 被拒绝的 URL。 */
  public readonly url: string;

  public constructor(message: string, url: string) {
    super(ErrorCode.EGRESS_BLOCKED, message);
    this.url = url;
  }
}
