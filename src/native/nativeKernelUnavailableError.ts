import { OmniError, ErrorCode } from '../omniError.js';

export class NativeKernelUnavailableError extends OmniError {
  public constructor(message: string) {
    super(ErrorCode.NATIVE_KERNEL_UNAVAILABLE, message);
  }
}
