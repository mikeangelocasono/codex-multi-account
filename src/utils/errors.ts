/**
 * Error types used across the CLI.
 *
 * `CmaError` carries a user-facing message that is safe to print verbatim: it
 * never contains credential material. Anything derived from a caught exception
 * must go through `describeError()` first so that stack traces and file
 * contents do not leak into the terminal.
 */

export type ErrorCode =
  | 'ACTIVE_WRITER'
  | 'AUTH_INVALID'
  | 'AUTH_MISSING'
  | 'CODEX_NOT_FOUND'
  | 'CODEX_FAILED'
  | 'CONFLICT'
  | 'INVALID_ARGUMENT'
  | 'IO'
  | 'LOCK_TIMEOUT'
  | 'NOT_FOUND'
  | 'NOT_SUPPORTED'
  | 'STATE_CORRUPT'
  | 'USER_ABORTED';

export class CmaError extends Error {
  readonly code: ErrorCode;
  /** Optional follow-up lines printed under the message (commands to run, etc). */
  readonly hint?: string;
  /** Process exit code to use when this error reaches the top level. */
  readonly exitCode: number;

  constructor(
    code: ErrorCode,
    message: string,
    options: { hint?: string; exitCode?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CmaError';
    this.code = code;
    this.hint = options.hint;
    this.exitCode = options.exitCode ?? 1;
  }
}

export function isCmaError(value: unknown): value is CmaError {
  return value instanceof CmaError;
}

/** Node's filesystem errors carry a `code`; surface it without the full object. */
export function errnoCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * Reduce an arbitrary thrown value to a single safe line.
 *
 * Only the message is used. Stack traces are dropped because they can contain
 * absolute paths of temporary credential files.
 */
export function describeError(error: unknown): string {
  if (isCmaError(error)) return error.message;
  if (error instanceof Error) {
    const code = errnoCode(error);
    const message = error.message || error.name;
    return code && !message.includes(code) ? `${message} (${code})` : message;
  }
  if (typeof error === 'string') return error;
  return 'unknown error';
}
