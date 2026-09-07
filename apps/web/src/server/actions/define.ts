import 'server-only';
import { getServices, defineAction, type ActionResult, type RequestContext } from '@vaultide/application';
import type { z } from 'zod';
import { requireSession } from '../context';

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
  input: Schema;
  handler: (args: { input: z.output<Schema>; ctx: RequestContext }) => Promise<Output>;
}): (raw: unknown) => Promise<ActionResult<Output>> {
  return defineAction(
    { getContext: requireSession, logger: getServices().logger },
    definition,
  );
}

export type { ActionResult };
