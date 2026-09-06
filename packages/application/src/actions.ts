import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { RequestContext } from './context';
import type {
  DomainError} from './errors';
import {
  InternalError,
  ValidationError,
  isDomainError,
  type ErrorCode,
  type FieldErrors,
} from './errors';
import { logAction, type Logger } from './logging';

/**
 * `defineAction` (blueprint 4.2, 19, 20).
 *
 * One helper wraps every mutation: parse the input with Zod (unknown keys
 * stripped), obtain the context, run the handler, map `DomainError`s to a
 * serializable result, and log exactly `{ action, userId, durationMs,
 * errorCode }` — never the payload.
 *
 * Actions never accept a `userId`: the identity comes from the session.
 */

export type ActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: ErrorCode;
        readonly message: string;
        readonly fieldErrors?: FieldErrors;
        readonly referenceId?: string;
      };
    };

export interface ActionDependencies {
  /** Fails closed: no session, no context (17.2). */
  readonly getContext: () => Promise<RequestContext>;
  readonly logger: Logger;
}

export interface ActionDefinition<Schema extends z.ZodType, Output> {
  readonly name: string;
  readonly input: Schema;
  readonly handler: (args: {
    input: z.output<Schema>;
    ctx: RequestContext;
  }) => Promise<Output>;
}

function fieldErrorsOf(error: z.ZodError): FieldErrors {
  const fieldErrors: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.length === 0 ? '_' : issue.path.join('.');
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return fieldErrors;
}

export function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

export function failure(error: DomainError): ActionResult<never> {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.fieldErrors === undefined ? {} : { fieldErrors: error.fieldErrors }),
      ...(error instanceof InternalError ? { referenceId: error.referenceId } : {}),
    },
  };
}

/**
 * Build a server action. The returned function is what a route or a form calls;
 * it never throws for an expected failure — it returns a typed result.
 */
export function defineAction<Schema extends z.ZodType, Output>(
  deps: ActionDependencies,
  definition: ActionDefinition<Schema, Output>,
): (raw: unknown) => Promise<ActionResult<Output>> {
  return async (raw: unknown) => {
    const startedAt = Date.now();
    let ctx: RequestContext | undefined;

    try {
      ctx = await deps.getContext();

      const parsed = definition.input.safeParse(raw);
      if (!parsed.success) {
        throw new ValidationError('Please check the highlighted fields.', fieldErrorsOf(parsed.error));
      }

      const data = await definition.handler({ input: parsed.data, ctx });

      logAction(deps.logger, {
        requestId: ctx.requestId,
        userId: ctx.userId,
        action: definition.name,
        durationMs: Date.now() - startedAt,
      });
      return ok(data);
    } catch (caught) {
      const error = isDomainError(caught) ? caught : new InternalError(randomUUID());

      if (error.logLevel !== 'none') {
        logAction(deps.logger, {
          requestId: ctx?.requestId ?? 'unknown',
          ...(ctx === undefined ? {} : { userId: ctx.userId }),
          action: definition.name,
          durationMs: Date.now() - startedAt,
          errorCode: error.code,
        });
      }

      if (!isDomainError(caught) && caught instanceof Error) {
        // The original stack is useful; the message is not trusted for display.
        deps.logger.error(
          { request_id: ctx?.requestId ?? 'unknown', error_code: 'INTERNAL', err: caught.name },
          'unhandled_error',
        );
      }

      return failure(error);
    }
  };
}
