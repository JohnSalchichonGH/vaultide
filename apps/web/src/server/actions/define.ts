import 'server-only';
import {
  getServices,
  defineAction,
  type ActionInput,
  type ActionResult,
  type RequestContext,
} from '@vaultide/application';
import type { z } from 'zod';
import { requireAuthoritativeSession, requireSession } from '../context';

/**
 * The one wrapper every mutation goes through (blueprint 4.2, 19, 20.2).
 *
 * `defineAction` in `@vaultide/application` does the work: parse with Zod
 * (unknown keys stripped), obtain the session, run the handler, map a
 * `DomainError` to a serializable result, and log `{ action, userId,
 * durationMs, errorCode }` and nothing else (18.2).
 *
 * This file supplies the two things that are specific to the web app: how to
 * get a session out of a Next.js request, and which logger to use. It exists so
 * that no server action ever assembles those itself — and so that no action can
 * accidentally accept a `userId` from its input.
 */
export function action<Schema extends z.ZodType, Output>(definition: {
  name: string;
  input: ActionInput<Schema>;
  handler: (args: { input: z.output<Schema>; ctx: RequestContext }) => Promise<Output>;
}): (raw: unknown) => Promise<ActionResult<Output>> {
  return defineAction(
    { getContext: requireSession, logger: getServices().logger },
    definition,
  );
}

/**
 * The wrapper every **financial** mutation must go through, from Phase 2 on.
 *
 * Identical to `action` except that the session is validated against the
 * session store rather than the signed cookie cache, so a revoked session
 * cannot write a valuation, a flow or a balance during the five-minute window
 * ADR 0002 decision 14 describes. The rule and its reasoning are in ADR 0003.
 *
 * It is a separate factory rather than a flag on `action` on purpose: a boolean
 * someone forgets to pass is invisible in review, whereas a financial mutation
 * declared with the wrong factory is a question anyone reading the file can
 * ask. Phase 2 declares every one of its mutations with it, and
 * `test/financial-actions.test.ts` enumerates this directory and fails if a new
 * action appears that uses the ordinary wrapper without being on the explicit
 * non-financial list.
 */
export function financialAction<Schema extends z.ZodType, Output>(definition: {
  name: string;
  input: ActionInput<Schema>;
  handler: (args: { input: z.output<Schema>; ctx: RequestContext }) => Promise<Output>;
}): (raw: unknown) => Promise<ActionResult<Output>> {
  return defineAction(
    { getContext: requireAuthoritativeSession, logger: getServices().logger },
    definition,
  );
}

export type { ActionResult };
