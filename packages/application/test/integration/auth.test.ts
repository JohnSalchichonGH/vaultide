import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authSession, eq, withoutUser } from '@vaultide/db';
import { generateSync } from 'otplib';
import { createAuthClient, tokenFromUrl, type AuthClient } from '../helpers/auth-client';
import { createHarness, TEST_BASE_URL, type Harness } from '../helpers/harness';
import { SESSION_EXPIRES_IN, SESSION_FRESH_AGE } from '../../src/auth/config';
import { requireSession, getSessionContext } from '../../src/auth/session';
import { listCategories } from '../../src/users/categories';
import { requiredSystemCategoryKinds } from '../../src/users/default-categories';
import { remainingUserRows, userExists } from '../../src/users/deletion';

/**
 * Better Auth integration (blueprint 17.1, 17.3, 21.3, 21.4).
 *
 * Everything runs against a real PostgreSQL database provisioned by the same
 * scripts production uses, and every request goes through `auth.handler`, so
 * the origin check, the DB-backed rate limits and the cookies are exercised
 * rather than bypassed.
 */

const PASSWORD = 'correct-horse-battery-staple-2026';
const WEAK = 'short';

let harness: Harness;
let client: AuthClient;

function unique(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}@example.test`;
}

/** How many session rows this user has. Sessions are rows, not just cookies. */
async function sessionRowCount(userId: string): Promise<number> {
  const rows = await withoutUser(harness.db, async (tx) =>
    tx.select({ id: authSession.id }).from(authSession).where(eq(authSession.userId, userId)),
  );
  return rows.length;
}

/** Is the session row still in the database? Sessions are rows, not just cookies. */
async function sessionRowExists(sessionId: string): Promise<boolean> {
  const rows = await withoutUser(harness.db, async (tx) =>
    tx.select({ id: authSession.id }).from(authSession).where(eq(authSession.id, sessionId)),
  );
  return rows.length > 0;
}

/** Sign up, read the captured verification link, verify, and sign in. */
async function signUpVerified(email: string, name = 'Test Person'): Promise<string> {
  await client.post('/sign-up/email', { name, email, password: PASSWORD });
  const message = harness.mailer.latestFor(email, 'verification');
  if (message === undefined) throw new Error('no verification email');
  await client.get(`/verify-email?token=${encodeURIComponent(tokenFromUrl(message.text))}`);
  return email;
}

beforeAll(async () => {
  harness = await createHarness();
}, 240_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(() => {
  client = createAuthClient(harness.services.auth, TEST_BASE_URL);
  harness.mailer.clear();
});

describe('sign-up and email verification', () => {
  it('creates the user, sends a verification email, and issues no session', async () => {
    const email = unique('verify');
    const response = await client.post('/sign-up/email', {
      name: 'Ada Lovelace',
      email,
      password: PASSWORD,
    });

    expect(response.status).toBe(200);
    // 17.1 `autoSignIn: false`: signing up must not sign you in, or the
    // verification gate would be decorative.
    expect(client.cookies.size).toBe(0);

    const message = harness.mailer.latestFor(email, 'verification');
    expect(message?.subject).toContain('Vaultide');
    expect(message?.text).toContain('Confirm');
  });

  it('refuses to sign in before the address is verified', async () => {
    const email = unique('unverified');
    await client.post('/sign-up/email', { name: 'Test', email, password: PASSWORD });

    const signIn = await client.post('/sign-in/email', { email, password: PASSWORD });
    expect(signIn.status).toBeGreaterThanOrEqual(400);
    expect(client.cookies.size).toBe(0);
  });

  it('signs in once verified', async () => {
    const email = await signUpVerified(unique('happy'));
    client.clearCookies();

    const signIn = await client.post('/sign-in/email', { email, password: PASSWORD });
    expect(signIn.status).toBe(200);
    expect(client.cookies.size).toBeGreaterThan(0);
  });

  it('refuses a password shorter than the twelve-character minimum', async () => {
    const response = await client.post('/sign-up/email', {
      name: 'Test',
      email: unique('weak'),
      password: WEAK,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a password that has appeared in a public breach', async () => {
    // 17.1: Have I Been Pwned, by k-anonymity. This password is in the corpus
    // many times over and is long enough to pass the length rule, so the only
    // thing that can reject it is the breach check.
    const response = await client.post('/sign-up/email', {
      name: 'Test',
      email: unique('pwned'),
      password: 'password123456789',
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(response.body)).toMatch(/breach|compromis/iu);
  });
});

describe('enumeration resistance (17.3)', () => {
  it('answers a repeat sign-up the same way as a first one, and warns the owner', async () => {
    const email = unique('enumerate');
    const first = await client.post('/sign-up/email', { name: 'First', email, password: PASSWORD });
    harness.mailer.clear();

    const second = await client.post('/sign-up/email', {
      name: 'Impostor',
      email,
      password: PASSWORD,
    });

    // Indistinguishable to the person signing up...
    expect(second.status).toBe(first.status);
    expect(Object.keys(second.body as object).sort()).toEqual(
      Object.keys(first.body as object).sort(),
    );
    // ...but the real owner is told an attempt was made, which is what makes
    // the flow safe rather than merely opaque.
    const warning = harness.mailer.latestFor(email, 'existing-account-signup');
    expect(warning).toBeDefined();
    expect(warning?.text).toContain('already exists');
    // And no second verification email went out.
    expect(harness.mailer.latestFor(email, 'verification')).toBeUndefined();
  });

  it('reports success for a reset request to an address that does not exist', async () => {
    const response = await client.post('/request-password-reset', {
      email: unique('nobody'),
      redirectTo: `${TEST_BASE_URL}/reset`,
    });
    expect(response.status).toBe(200);
    expect(harness.mailer.messages).toHaveLength(0);
  });
});

describe('password reset (17.1)', () => {
  it('sends a single-use link, changes the password, and revokes every session', async () => {
    const email = await signUpVerified(unique('reset'));

    // A live session on another device.
    const other = createAuthClient(harness.services.auth, TEST_BASE_URL);
    await other.post('/sign-in/email', { email, password: PASSWORD });
    const beforeReset = await other.get<{ user: { id: string } }>('/get-session');
    expect(beforeReset.body).not.toBeNull();
    const userId = beforeReset.body.user.id;
    expect(await sessionRowCount(userId)).toBeGreaterThan(0);

    harness.mailer.clear();
    const requested = await client.post('/request-password-reset', {
      email,
      redirectTo: `${TEST_BASE_URL}/reset`,
    });
    expect(requested.status).toBe(200);

    const message = harness.mailer.latestFor(email, 'reset-password');
    expect(message?.text).toContain('signs you out everywhere else');
    const token = tokenFromUrl(message?.text ?? '');

    const NEW_PASSWORD = 'a-completely-different-passphrase-2026';
    const reset = await client.post('/reset-password', { token, newPassword: NEW_PASSWORD });
    expect(reset.status).toBe(200);

    /**
     * 17.1 `revokeSessionsOnPasswordReset`: every other session is revoked.
     *
     * Revocation is the deletion of the rows, which is what makes it hold on
     * devices this process will never see again. The five-minute signed cookie
     * cache that 17.1 also asks for means an ordinary `get-session` read can
     * still answer from the cookie for a few minutes; every endpoint that
     * authorizes something re-reads the store, which is asserted below.
     */
    expect(await sessionRowCount(userId)).toBe(0);
    expect(
      await harness.services.auth.api.getSession({
        headers: new Headers({ Cookie: other.cookieHeader() }),
        query: { disableCookieCache: true },
      }),
    ).toBeNull();
    // A sensitive endpoint re-reads the store, so the revoked device cannot act.
    expect((await other.post('/revoke-other-sessions')).status).toBe(401);

    // The token is single-use.
    const replay = await client.post('/reset-password', { token, newPassword: NEW_PASSWORD });
    expect(replay.status).toBeGreaterThanOrEqual(400);

    // The old password no longer works; the new one does.
    const fresh = createAuthClient(harness.services.auth, TEST_BASE_URL);
    expect((await fresh.post('/sign-in/email', { email, password: PASSWORD })).status).toBeGreaterThanOrEqual(400);
    expect((await fresh.post('/sign-in/email', { email, password: NEW_PASSWORD })).status).toBe(200);
  });
});

describe('sessions', () => {
  it('carries the blueprint expiry and freshness windows', () => {
    expect(SESSION_EXPIRES_IN).toBe(60 * 60 * 24 * 30);
    expect(SESSION_FRESH_AGE).toBe(600);
  });

  it('is stored in the database, so signing out revokes the row itself', async () => {
    const email = await signUpVerified(unique('session'));
    client.clearCookies();
    await client.post('/sign-in/email', { email, password: PASSWORD });

    const before = await client.get<{ session: { id: string } }>('/get-session');
    expect(before.body).not.toBeNull();
    const sessionId = before.body.session.id;
    const cookieHeader = client.cookieHeader();

    expect(await sessionRowExists(sessionId)).toBe(true);

    await client.post('/sign-out');

    // 17.1 "Sessions: DB-backed": revocation is a deleted row, not merely a
    // cleared cookie, so it holds for every device and cannot be undone by
    // replaying a stolen token.
    expect(await sessionRowExists(sessionId)).toBe(false);
    expect(client.cookies.size).toBe(0);

    // A request that bypasses the signed cookie cache — which 17.1 enables for
    // five minutes and which is the only thing a replayed cookie could still
    // satisfy — gets nothing.
    const replay = await harness.services.auth.api.getSession({
      headers: new Headers({ Cookie: cookieHeader }),
      query: { disableCookieCache: true },
    });
    expect(replay).toBeNull();
  });

  it('builds a request context from the session, never from input', async () => {
    const email = await signUpVerified(unique('context'));
    client.clearCookies();
    await client.post('/sign-in/email', { email, password: PASSWORD });

    const headers = new Headers({ Cookie: client.cookieHeader() });
    const context = await requireSession(
      { auth: harness.services.auth, db: harness.db },
      headers,
    );

    expect(context.email).toBe(email);
    expect(context.userId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(context.today).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    // Provisioning defaults until onboarding sets the real values.
    expect(context.settings.baseCurrency).toBe('EUR');
    expect(context.settings.timezone).toBe('UTC');
    // A brand-new session is fresh.
    expect(context.sessionFresh).toBe(true);
  });

  it('fails closed with no session at all', async () => {
    await expect(
      requireSession({ auth: harness.services.auth, db: harness.db }, new Headers()),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });

    await expect(
      getSessionContext({ auth: harness.services.auth, db: harness.db }, new Headers()),
    ).resolves.toBeUndefined();
  });
});

describe('provisioning on sign-up', () => {
  it('creates settings, every system category and the starter categories', async () => {
    await signUpVerified(unique('provision'));
    const headers = new Headers({ Cookie: client.cookieHeader() });
    const context = await requireSession(
      { auth: harness.services.auth, db: harness.db },
      headers,
    );

    const rows = await remainingUserRows(harness.db, context.userId);
    expect(rows.user_settings).toBe(1);
    expect(rows.categories).toBeGreaterThan(0);

    // Every one of the seven system kinds exists exactly once (6.2).
    const categories = await listCategories(harness.db, context.userId);
    for (const kind of requiredSystemCategoryKinds) {
      expect(categories.filter((category) => category.kind === kind)).toHaveLength(1);
    }
  });
});

describe('two-factor authentication (17.1)', () => {
  it('enables TOTP, gates sign-in on a code, and accepts a backup code', async () => {
    const email = await signUpVerified(unique('totp'));
    client.clearCookies();
    await client.post('/sign-in/email', { email, password: PASSWORD });

    const enabled = await client.post<{ totpURI: string; backupCodes: string[] }>(
      '/two-factor/enable',
      { password: PASSWORD },
    );
    expect(enabled.status).toBe(200);
    const secret = new URL(enabled.body.totpURI).searchParams.get('secret');
    expect(secret).not.toBeNull();
    // The issuer is what an authenticator app shows the user (17.1).
    expect(enabled.body.totpURI).toContain('Vaultide');
    expect(enabled.body.backupCodes.length).toBeGreaterThan(0);

    // Better Auth requires the first TOTP code to confirm the factor.
    await client.post('/two-factor/verify-totp', {
      code: generateSync({ secret: secret as string }),
    });

    // A new sign-in now stops at the second factor rather than issuing a session.
    const second = createAuthClient(harness.services.auth, TEST_BASE_URL);
    const challenge = await second.post<{ twoFactorRedirect?: boolean }>('/sign-in/email', {
      email,
      password: PASSWORD,
    });
    expect(challenge.body.twoFactorRedirect).toBe(true);
    expect((await second.get('/get-session')).body).toBeNull();

    const wrong = await second.post('/two-factor/verify-totp', { code: '000000' });
    expect(wrong.status).toBeGreaterThanOrEqual(400);

    const right = await second.post('/two-factor/verify-totp', {
      code: generateSync({ secret: secret as string }),
    });
    expect(right.status).toBe(200);
    expect((await second.get('/get-session')).body).not.toBeNull();

    // A backup code works when the phone does not.
    const third = createAuthClient(harness.services.auth, TEST_BASE_URL);
    await third.post('/sign-in/email', { email, password: PASSWORD });
    const backup = await third.post('/two-factor/verify-backup-code', {
      code: enabled.body.backupCodes[0] as string,
    });
    expect(backup.status).toBe(200);

    // ...and only once.
    const fourth = createAuthClient(harness.services.auth, TEST_BASE_URL);
    await fourth.post('/sign-in/email', { email, password: PASSWORD });
    const reuse = await fourth.post('/two-factor/verify-backup-code', {
      code: enabled.body.backupCodes[0] as string,
    });
    expect(reuse.status).toBeGreaterThanOrEqual(400);
  });

  it('disabling 2FA requires the password', async () => {
    const email = await signUpVerified(unique('totp-off'));
    client.clearCookies();
    await client.post('/sign-in/email', { email, password: PASSWORD });

    const enabled = await client.post<{ totpURI: string }>('/two-factor/enable', {
      password: PASSWORD,
    });
    const secret = new URL(enabled.body.totpURI).searchParams.get('secret') as string;
    await client.post('/two-factor/verify-totp', { code: generateSync({ secret }) });

    const wrongPassword = await client.post('/two-factor/disable', { password: 'not-the-password' });
    expect(wrongPassword.status).toBeGreaterThanOrEqual(400);

    const disabled = await client.post('/two-factor/disable', { password: PASSWORD });
    expect(disabled.status).toBe(200);

    // Sign-in no longer stops at a second factor.
    const after = createAuthClient(harness.services.auth, TEST_BASE_URL);
    const response = await after.post<{ twoFactorRedirect?: boolean }>('/sign-in/email', {
      email,
      password: PASSWORD,
    });
    expect(response.body.twoFactorRedirect).toBeUndefined();
  });
});

describe('origin checking (17.3)', () => {
  it('refuses a state-changing request from another origin', async () => {
    const email = await signUpVerified(unique('origin'));

    const foreign = createAuthClient(harness.services.auth, TEST_BASE_URL, {
      origin: 'https://attacker.example',
    });
    const response = await foreign.post('/sign-in/email', { email, password: PASSWORD });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(foreign.cookies.size).toBe(0);
  });
});

describe('account deletion (18.3)', () => {
  it('requires the password and removes every user-owned row', async () => {
    const email = await signUpVerified(unique('delete'));
    client.clearCookies();
    await client.post('/sign-in/email', { email, password: PASSWORD });

    const context = await requireSession(
      { auth: harness.services.auth, db: harness.db },
      new Headers({ Cookie: client.cookieHeader() }),
    );
    const before = await remainingUserRows(harness.db, context.userId);
    expect(before.user_settings).toBe(1);
    expect(before.categories).toBeGreaterThan(0);

    // Re-authentication is not optional.
    const wrong = await client.post('/delete-user', { password: 'not-the-password' });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(await userExists(harness.db, context.userId)).toBe(true);

    harness.mailer.clear();
    const deleted = await client.post('/delete-user', { password: PASSWORD });
    expect(deleted.status).toBe(200);

    expect(await userExists(harness.db, context.userId)).toBe(false);
    const after = await remainingUserRows(harness.db, context.userId);
    expect(after).toEqual({ user_settings: 0, categories: 0, tags: 0 });

    // 18.3: a confirmation email is sent once the data is gone.
    expect(harness.mailer.latestFor(email, 'account-deleted')).toBeDefined();
  });
});
