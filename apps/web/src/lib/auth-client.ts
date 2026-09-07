'use client';

import { createAuthClient } from 'better-auth/react';
import { twoFactorClient } from 'better-auth/client/plugins';

/**
 * The browser-side auth client (blueprint 17.1).
 *
 * It talks to `/api/auth/*` on the same origin — there is no base URL to
 * configure and no cross-origin request to allow. The session lives in an
 * `HttpOnly` cookie the browser sends automatically; this module never sees a
 * token and never stores one.
 */
export const authClient = createAuthClient({
  plugins: [twoFactorClient()],
});

/**
 * Callers use `authClient.signIn.email(...)` rather than destructured helpers.
 * Better Auth builds those helpers from a proxy whose type cannot be named
 * outside the package, so re-exporting them would need a `.d.ts` path that
 * only resolves inside this workspace.
 */
