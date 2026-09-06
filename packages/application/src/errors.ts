/**
 * Error taxonomy (blueprint 20.2).
 *
 * Every failure the user can cause has a code, a safe message and a defined
 * logging level. Messages never interpolate user financial values (18.2): the
 * amount that failed a rule is shown by the UI from its own state, not echoed
 * through a log-bound error string.
 */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTH_REQUIRED'
  | 'NOT_FOUND'
  | 'CONFLICT_VERSION'
  | 'CONFLICT_DUPLICATE'
  | 'IMPOSSIBLE_OPERATION'
  | 'INCOMPLETE_DATA'
  | 'FX_UNAVAILABLE'
  | 'FX_PROVIDER_FAILURE'
  | 'SCENARIO_INVALID'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export type LogLevel = 'none' | 'count' | 'info' | 'warn' | 'error';

/** How each code is logged (20.2), so no call site has to decide. */
export const LOG_LEVEL_BY_CODE: Record<ErrorCode, LogLevel> = {
  VALIDATION_ERROR: 'count',
  AUTH_REQUIRED: 'none',
  NOT_FOUND: 'none',
  CONFLICT_VERSION: 'info',
  CONFLICT_DUPLICATE: 'info',
  IMPOSSIBLE_OPERATION: 'info',
  INCOMPLETE_DATA: 'info',
  FX_UNAVAILABLE: 'warn',
  FX_PROVIDER_FAILURE: 'error',
  SCENARIO_INVALID: 'none',
  RATE_LIMITED: 'info',
  INTERNAL: 'error',
};

export type FieldErrors = Record<string, string[]>;

export abstract class DomainError extends Error {
  abstract readonly code: ErrorCode;
  readonly fieldErrors?: FieldErrors;

  protected constructor(message: string, fieldErrors?: FieldErrors) {
    super(message);
    this.name = new.target.name;
    if (fieldErrors !== undefined) this.fieldErrors = fieldErrors;
  }

  get logLevel(): LogLevel {
    return LOG_LEVEL_BY_CODE[this.code];
  }
}

export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_ERROR';
  constructor(message = 'Please check the highlighted fields.', fieldErrors?: FieldErrors) {
    super(message, fieldErrors);
  }
}

export class AuthRequiredError extends DomainError {
  readonly code = 'AUTH_REQUIRED';
  constructor(message = 'Please sign in to continue.') {
    super(message);
  }
}

export class NotFoundError extends DomainError {
  readonly code = 'NOT_FOUND';
  /** Also raised when a record belongs to another user: existence is not leaked. */
  constructor(message = 'Not found.') {
    super(message);
  }
}

export class VersionConflictError extends DomainError {
  readonly code = 'CONFLICT_VERSION';
  constructor(message = 'This was changed elsewhere. Reload to see the current values.') {
    super(message);
  }
}

export class DuplicateConflictError extends DomainError {
  readonly code = 'CONFLICT_DUPLICATE';
  constructor(message = 'This record already exists.') {
    super(message);
  }
}

export class ImpossibleOperationError extends DomainError {
  readonly code = 'IMPOSSIBLE_OPERATION';
  constructor(message: string) {
    super(message);
  }
}

export class IncompleteDataError extends DomainError {
  readonly code = 'INCOMPLETE_DATA';
  constructor(message: string) {
    super(message);
  }
}

export class FxUnavailableError extends DomainError {
  readonly code = 'FX_UNAVAILABLE';
  constructor(message = 'An exchange rate is not available yet.') {
    super(message);
  }
}

export class FxProviderFailureError extends DomainError {
  readonly code = 'FX_PROVIDER_FAILURE';
  constructor(message = 'Exchange rates are being fetched. Try again shortly.') {
    super(message);
  }
}

export class ScenarioInvalidError extends DomainError {
  readonly code = 'SCENARIO_INVALID';
  constructor(message = 'This scenario definition is not valid.', fieldErrors?: FieldErrors) {
    super(message, fieldErrors);
  }
}

export class RateLimitedError extends DomainError {
  readonly code = 'RATE_LIMITED';
  constructor(readonly retryAfterSeconds: number) {
    super('Too many attempts. Try again in a few minutes.');
  }
}

export class InternalError extends DomainError {
  readonly code = 'INTERNAL';
  constructor(readonly referenceId: string) {
    super('Something went wrong. Quote the reference id if you report this.');
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
