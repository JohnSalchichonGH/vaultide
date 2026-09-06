import { pino, type Logger } from 'pino';

/**
 * Structured logging with redaction (blueprint 18.2).
 *
 * The log schema is fixed and small: time, level, request id, user id, the
 * action or route, a duration and an error code. DTOs, inputs and financial
 * values are never passed to the logger; the `redact` list is a backstop, not
 * the policy.
 */

/** Keys that must never reach a log line, even by accident. */
export const REDACTED_KEY_PATTERN =
  /^(amount|balance|value|rate|price|net|gross|total|salary|payment|principal|interest|basis)/iu;

const REDACT_PATHS = [
  'amount',
  'balance',
  'value',
  'rate',
  'price',
  'net',
  'gross',
  'total',
  'salary',
  'payment',
  'principal',
  'interest',
  'basis',
  'password',
  'token',
  'secret',
  'authorization',
  'cookie',
].flatMap((key) => [key, `*.${key}`, `*.*.${key}`]);

export interface LoggerOptions {
  readonly level?: string;
  readonly pretty?: boolean;
  readonly destination?: NodeJS.WritableStream;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const base = {
    level: options.level ?? process.env.LOG_LEVEL ?? 'info',
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return options.destination === undefined ? pino(base) : pino(base, options.destination);
}

/** The only shape an action or route ever logs (18.2). */
export interface ActionLogFields {
  readonly requestId: string;
  readonly userId?: string;
  readonly action?: string;
  readonly route?: string;
  readonly durationMs: number;
  readonly errorCode?: string;
  readonly entityTable?: string;
  readonly entityId?: string;
}

/**
 * Build the log record, dropping everything that is not part of the schema.
 * Passing a DTO here cannot leak: only the known keys survive.
 */
export function actionLogRecord(fields: ActionLogFields): Record<string, string | number> {
  const record: Record<string, string | number> = {
    request_id: fields.requestId,
    duration_ms: fields.durationMs,
  };
  if (fields.userId !== undefined) record['user_id'] = fields.userId;
  if (fields.action !== undefined) record['action'] = fields.action;
  if (fields.route !== undefined) record['route'] = fields.route;
  if (fields.errorCode !== undefined) record['error_code'] = fields.errorCode;
  if (fields.entityTable !== undefined) record['entity_table'] = fields.entityTable;
  if (fields.entityId !== undefined) record['entity_id'] = fields.entityId;
  return record;
}

export function logAction(logger: Logger, fields: ActionLogFields): void {
  const record = actionLogRecord(fields);
  if (fields.errorCode === undefined) logger.info(record, 'action');
  else logger.warn(record, 'action_failed');
}

export type { Logger };
