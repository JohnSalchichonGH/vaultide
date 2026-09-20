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
  | 'WRITE_BUSY'
  | 'HISTORICAL_REVIEW_REQUIRED'
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
  WRITE_BUSY: 'info',
  HISTORICAL_REVIEW_REQUIRED: 'info',
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

/**
 * Another financial write of the same user held the write mutex for longer than
 * a request may wait, twice (blueprint 20.2, 20.3, 30.22; ADR 0010 §7).
 *
 * A benign, retryable conflict and deliberately **not** an internal failure: it
 * writes nothing, it names no database and no SQLSTATE, and it hands out no
 * internal-error reference id for what is ordinary contention. The message says
 * the two things the user needs — nothing was saved, and trying again is the
 * right response.
 */
export class WriteBusyError extends DomainError {
  readonly code = 'WRITE_BUSY';
  constructor(message = 'Another change is still saving. Nothing was saved — try again.') {
    super(message);
  }
}

/**
 * The write would revise completed history, and no consent was given for it
 * (blueprint 30.22 items 1 and 2; ADR 0010 §1).
 *
 * A safety boundary rather than the intended interaction. The interface routes
 * an expected historical revision through Preview → Confirm before it ever gets
 * here; this is what answers a caller that did not — a bypassed client, or a
 * web layer that could not anticipate a hidden dormancy consequence.
 *
 * It is its own code precisely so the interface can tell it apart from a
 * validation failure and open the review ceremony instead of showing a red
 * error about data the user did nothing wrong with. `reasons` says which of the
 * two rules applied, so the interface can explain the dormancy case, which is
 * the one a user has no reason to expect.
 *
 * Nothing was written when this is raised: the classification happens after the
 * write has been fully resolved and before its first mutation.
 */
export class HistoricalReviewRequiredError extends DomainError {
  readonly code = 'HISTORICAL_REVIEW_REQUIRED';
  constructor(
    readonly reasons: readonly string[],
    readonly completedPeriods: readonly string[],
    message = 'This change rewrites a month that is already closed, so it has to be reviewed before it is saved. Nothing was saved.',
  ) {
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
