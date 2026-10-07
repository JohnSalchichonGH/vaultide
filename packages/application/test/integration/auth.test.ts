import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { USER_OWNED_TABLES, authSession, eq, withoutUser } from '@vaultide/db';
import { generateSync } from 'otplib';
import {
  createAuthClient,
  tokenFromUrl,
  urlFromMessage,
  type AuthClient,
  type AuthResponse,
} from '../helpers/auth-client';
import { createHarness, TEST_BASE_URL, type Harness } from '../helpers/harness';
import { SESSION_EXPIRES_IN, SESSION_FRESH_AGE, createAuth, type Auth } from '../../src/auth/config';
import { createLogger } from '../../src/logging';
import { MailDeliveryError, type MailMessage } from '../../src/mail/mailer';
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

/** The link in the latest verification message to this address. */
function verificationLink(email: string): URL {
  const message = harness.mailer.latestFor(email, 'verification');
  if (message === undefined) throw new Error('no verification email');
  return new URL(urlFromMessage(message.text));
}

/** Follow a captured link as a browser would, through the auth handler. */
async function follow(through: AuthClient, link: URL): Promise<AuthResponse> {
  expect(link.pathname.startsWith('/api/auth/')).toBe(true);
  return through.get(`${link.pathname.slice('/api/auth'.length)}${link.search}`);
}

/** Every message sent to this address since the mailbox was last cleared. */
function messagesTo(email: string): readonly { readonly tag: string }[] {
  return harness.mailer.messages.filter((message) => message.to === email);
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

/** A real token with one character of its signature changed. */
function alterSignature(token: string): string {
  const parts = token.split('.');
  const signature = parts[2];
  if (parts.length !== 3 || signature === undefined || signature === '') {
    throw new Error('not a JWT');
  }
  const first = signature.startsWith('A') ? 'B' : 'A';
  return `${parts[0] ?? ''}.${parts[1] ?? ''}.${first}${signature.slice(1)}`;
}

describe('a new confirmation link (17.3, ADR 0002 decision 21)', () => {
  it('lands every link on /verify: a sign-up’s and a resend’s', async () => {
    const email = unique('landing');
    await client.post('/sign-up/email', { name: 'Test', email, password: PASSWORD });
    expect(verificationLink(email).searchParams.get('callbackURL')).toBe('/verify');

    harness.mailer.clear();
    expect((await client.post('/send-verification-email', { email })).status).toBe(200);
    expect(verificationLink(email).searchParams.get('callbackURL')).toBe('/verify');
  });

  it('redirects a followed link to /verify, and a broken one to /verify?error=', async () => {
    const email = unique('follow');
    await client.post('/sign-up/email', { name: 'Test', email, password: PASSWORD });
    const link = verificationLink(email);

    const broken = new URL(link);
    broken.searchParams.set('token', alterSignature(link.searchParams.get('token') ?? ''));
    const refused = await follow(client, broken);
    expect(refused.status).toBe(302);
    expect(refused.headers.get('location')).toBe('/verify?error=INVALID_TOKEN');
    expect(client.cookies.size).toBe(0);

    const followed = await follow(client, link);
    expect(followed.status).toBe(302);
    expect(followed.headers.get('location')).toBe('/verify');
    // 17.1 `autoSignInAfterVerification`: the redirect carries a session.
    expect(client.cookies.size).toBeGreaterThan(0);
  });

  it('sends one new link to an account waiting for confirmation, and that link confirms it', async () => {
    const email = unique('resend');
    await client.post('/sign-up/email', { name: 'Test', email, password: PASSWORD });
    harness.mailer.clear();

    expect((await client.post('/send-verification-email', { email })).status).toBe(200);
    expect(messagesTo(email).map((message) => message.tag)).toEqual(['verification']);

    expect((await follow(client, verificationLink(email))).status).toBe(302);
    client.clearCookies();
    expect((await client.post('/sign-in/email', { email, password: PASSWORD })).status).toBe(200);
  });

  it('answers an unknown address and a confirmed one as it answers a waiting one, and sends them nothing', async () => {
    const waiting = unique('waiting');
    await client.post('/sign-up/email', { name: 'Test', email: waiting, password: PASSWORD });
    const confirmed = await signUpVerified(unique('confirmed'));
    const unknown = unique('unknown');
    harness.mailer.clear();

    // Without a session, as somebody asking from `/verify` is. With one, the
    // endpoint answers about that session's own address instead.
    const anonymous = createAuthClient(harness.services.auth, TEST_BASE_URL);
    for (const email of [waiting, confirmed, unknown]) {
      const started = performance.now();
      const response = await anonymous.post('/send-verification-email', { email });
      const elapsed = performance.now() - started;

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: true });
      // Better Auth holds every anonymous answer to at least 500 ms, so a
      // message being sent cannot be told apart by the time it takes. The
      // margin covers a timer that fires a millisecond early.
      expect(elapsed).toBeGreaterThanOrEqual(490);
    }

    expect(harness.mailer.messages.map((message) => [message.to, message.tag])).toEqual([
      [waiting, 'verification'],
    ]);
  });

  it('refuses the right password on an unconfirmed account with EMAIL_NOT_VERIFIED, and sends nothing', async () => {
    const email = unique('no-resend-on-sign-in');
    await client.post('/sign-up/email', { name: 'Test', email, password: PASSWORD });
    harness.mailer.clear();

    // The refusal names the reason only once the password has matched, so the
    // sign-in form's message for it tells nothing to somebody without it.
    const wrong = await client.post<{ code?: string }>('/sign-in/email', {
      email,
      password: 'not-the-password-at-all',
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('INVALID_EMAIL_OR_PASSWORD');

    const right = await client.post<{ code?: string }>('/sign-in/email', { email, password: PASSWORD });
    expect(right.status).toBe(403);
    expect(right.body.code).toBe('EMAIL_NOT_VERIFIED');
    expect(client.cookies.size).toBe(0);

    // `sendOnSignIn` is off: signing in never sends a link.
    expect(harness.mailer.messages).toHaveLength(0);
  });
});

/**
 * Auth over the harness's database with a mailer that delivers until told to
 * fail, then refuses every message as a provider would. It keeps every
 * message it was asked to send, so a test can name the link that failed, and
 * every log line, so a test can read what the failure left behind.
 */
function authWithFailingMail(): {
  readonly client: AuthClient;
  readonly attempted: MailMessage[];
  readonly logLines: string[];
  readonly fail: () => void;
} {
  const attempted: MailMessage[] = [];
  const logLines: string[] = [];
  let failing = false;
  const auth: Auth = createAuth({
    db: harness.db,
    mailer: {
      id: 'failing',
      send(message) {
        attempted.push(message);
        return failing ? Promise.reject(new MailDeliveryError('failing', 422)) : Promise.resolve();
      },
    },
    secret: randomBytes(32).toString('hex'),
    baseURL: `${TEST_BASE_URL}/api/auth`,
    appUrl: TEST_BASE_URL,
    logger: createLogger({
      level: 'debug',
      destination: {
        write(chunk: string): boolean {
          logLines.push(chunk);
          return true;
        },
      } as NodeJS.WritableStream,
    }),
  });
  return {
    client: createAuthClient(auth, TEST_BASE_URL),
    attempted,
    logLines,
    fail: () => {
      failing = true;
    },
  };
}

/**
 * The failures logged, each checked to carry the 18.2 fields and nothing else:
 * no address, no link and no token can be in a field that is not there.
 */
function failuresLogged(logLines: readonly string[]): { action: string; user_id: string }[] {
  const failures = logLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record['msg'] === 'mail_delivery_failed');
  for (const record of failures) {
    expect(Object.keys(record).sort()).toEqual(['action', 'error_code', 'level', 'msg', 'time', 'user_id']);
    expect(record['error_code']).toBe('MAIL_DELIVERY_FAILED');
  }
  return failures as { action: string; user_id: string }[];
}

describe('a send that fails says nothing about the address (17.3, 18.2, ADR 0002 decision 21)', () => {
  it('answers a resend for a waiting account as for an unknown address, and logs the failure', async () => {
    const { client, attempted, logLines, fail } = authWithFailingMail();
    const waiting = unique('send-fails');
    await client.post('/sign-up/email', { name: 'Test', email: waiting, password: PASSWORD });
    fail();

    const answers = [];
    for (const email of [waiting, unique('send-fails-unknown')]) {
      const response = await client.post('/send-verification-email', { email });
      answers.push({ status: response.status, body: response.body });
    }
    expect(answers).toEqual([
      { status: 200, body: { status: true } },
      { status: 200, body: { status: true } },
    ]);

    // The resend did try to send to the waiting account, and that failed.
    const failed = attempted.at(-1);
    expect([failed?.to, failed?.tag]).toEqual([waiting, 'verification']);
    expect(failuresLogged(logLines).map((record) => record.action)).toEqual([
      'auth.sendVerificationEmail',
    ]);
    const logs = logLines.join('\n');
    expect(logs).not.toContain(waiting);
    expect(logs).not.toContain(tokenFromUrl(failed?.text ?? ''));
  });

  it('answers a sign-up for a new address as for a registered one, and logs the failed link', async () => {
    const { client, attempted, logLines, fail } = authWithFailingMail();
    const registered = unique('signup-fails-registered');
    await client.post('/sign-up/email', { name: 'First', email: registered, password: PASSWORD });
    fail();

    const fresh = unique('signup-fails-new');
    const first = await client.post('/sign-up/email', { name: 'Test', email: fresh, password: PASSWORD });
    const repeat = await client.post('/sign-up/email', {
      name: 'Impostor',
      email: registered,
      password: PASSWORD,
    });

    expect(first.status).toBe(200);
    expect(repeat.status).toBe(first.status);
    expect(Object.keys(repeat.body as object).sort()).toEqual(
      Object.keys(first.body as object).sort(),
    );

    // The new address's confirmation link and the registered owner's warning
    // both failed. Better Auth swallows a failed warning itself, into its own
    // log; the confirmation link's failure is ours to log.
    expect(attempted.slice(-2).map((message) => [message.to, message.tag])).toEqual([
      [fresh, 'verification'],
      [registered, 'existing-account-signup'],
    ]);
    expect(failuresLogged(logLines).map((record) => record.action)).toEqual([
      'auth.sendVerificationEmail',
    ]);
    const logs = logLines.join('\n');
    expect(logs).not.toContain(fresh);
    expect(logs).not.toContain(registered);
    expect(logs).not.toContain(tokenFromUrl(attempted.at(-2)?.text ?? ''));
  });

  it('answers a reset request for a registered address as for an unknown one, and logs the failure', async () => {
    const { client, attempted, logLines, fail } = authWithFailingMail();
    const registered = unique('reset-fails');
    await client.post('/sign-up/email', { name: 'Test', email: registered, password: PASSWORD });
    fail();

    const answers = [];
    for (const email of [registered, unique('reset-fails-unknown')]) {
      const response = await client.post('/request-password-reset', {
        email,
        redirectTo: `${TEST_BASE_URL}/reset`,
      });
      answers.push({ status: response.status, body: response.body });
    }
    // Better Auth already swallows a failed send on this route, into its own
    // log; the answer is pinned so that a change there cannot go unnoticed.
    expect(answers[0]?.status).toBe(200);
    expect(answers[1]).toEqual(answers[0]);

    const failed = attempted.at(-1);
    expect([failed?.to, failed?.tag]).toEqual([registered, 'reset-password']);
    expect(failuresLogged(logLines).map((record) => record.action)).toEqual([
      'auth.sendResetPassword',
    ]);
    const logs = logLines.join('\n');
    expect(logs).not.toContain(registered);
    expect(logs).not.toContain(tokenFromUrl(failed?.text ?? ''));
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
    // Every user-owned table, taken from the schema's own list rather than
    // spelled out here — a table added by a later phase has to be accounted for
    // by the cascade, and this assertion grows with it instead of going stale.
    const after = await remainingUserRows(harness.db, context.userId);
    expect(Object.keys(after).sort()).toEqual([...USER_OWNED_TABLES].sort());
    expect(Object.values(after)).toEqual(USER_OWNED_TABLES.map(() => 0));

    // 18.3: a confirmation email is sent once the data is gone.
    expect(harness.mailer.latestFor(email, 'account-deleted')).toBeDefined();
  });
});
