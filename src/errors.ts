export type DecideErrorCode =
  | "invalid_request"
  | "auth"
  | "rate_limited"
  | "upstream"
  | "timeout"
  | "network"
  | "malformed_response";

export interface DecideErrorOptions {
  readonly status?: number;
  readonly cause?: unknown;
  readonly retryable?: boolean;
}

export class DecideError extends Error {
  override readonly name = "DecideError";
  readonly code: DecideErrorCode;
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(code: DecideErrorCode, message: string, options: DecideErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}
