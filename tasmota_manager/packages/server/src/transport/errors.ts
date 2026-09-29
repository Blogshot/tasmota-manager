import type { ErrorCode } from '@tm/shared';

export class TransportError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}
