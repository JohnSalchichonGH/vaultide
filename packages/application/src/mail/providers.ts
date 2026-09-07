import { areTestEndpointsEnabled } from '../context';
import { MailDeliveryError, type Mailer, type MailMessage } from './mailer';

/**
 * Mail providers (blueprint 17.1, 22.1, 29.1 "decide in Phase 1").
 *
 * Two implementations:
 *
 *  - `createHttpMailer` — the production adapter. It posts a message to a
 *    provider's JSON API. The endpoint, the auth header and the payload shape
 *    are configuration rather than code, so the residency decision below can be
 *    revisited without touching anything that sends mail.
 *  - `createCapturingMailer` — the test double (17.1 "a capturing stub for
 *    tests"). It sends nothing and keeps the messages in memory, which is how
 *    the integration and E2E suites read a verification link.
 *
 * **Residency finding, recorded here because it changes the blueprint's
 * assumption:** 18.3 asks for an "email provider with an EU region", and 29.1
 * proposes Postmark or Resend. Neither stores account data in the EU: Postmark
 * (ActiveCampaign) is US-only with no EU region, and Resend's `eu-west-1` is a
 * *sending* region — account data, logs and message metadata stay in the US.
 * The adapter is therefore provider-agnostic and the choice is an operational
 * one, documented in `docs/ops/environment-setup.md`. Nothing in the codebase
 * assumes a particular vendor.
 */

export interface HttpMailerConfig {
  /** Identifies the provider in operational logs. */
  readonly id: string;
  /** Full URL of the send endpoint, e.g. `https://api.resend.com/emails`. */
  readonly endpoint: string;
  readonly apiKey: string;
  /** `Vaultide <no-reply@vaultide.app>` (22.2 `EMAIL_FROM`). */
  readonly from: string;
  /** Header carrying the credential. Defaults to a bearer `Authorization`. */
  readonly authHeader?: string;
  readonly authScheme?: string;
  /** Builds the provider's payload. Defaults to the Resend/Postmark-like shape. */
  readonly body?: (message: MailMessage, from: string) => unknown;
  /** Injected in tests so no network call is made. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const defaultBody = (message: MailMessage, from: string): unknown => ({
  from,
  to: [message.to],
  subject: message.subject,
  text: message.text,
  html: message.html,
  tags: [{ name: 'category', value: message.tag }],
});

export function createHttpMailer(config: HttpMailerConfig): Mailer {
  const send = config.fetchImpl ?? fetch;
  const buildBody = config.body ?? defaultBody;
  const header = config.authHeader ?? 'Authorization';
  const scheme = config.authScheme ?? 'Bearer ';

  return {
    id: config.id,
    async send(message: MailMessage): Promise<void> {
      let response: Response;
      try {
        response = await send(config.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [header]: `${scheme}${config.apiKey}`,
          },
          body: JSON.stringify(buildBody(message, config.from)),
          signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
        });
      } catch {
        // The cause is never propagated: a fetch error can carry the URL, and
        // the URL is not what failed in a way the user should read.
        throw new MailDeliveryError(config.id, undefined);
      }

      if (!response.ok) throw new MailDeliveryError(config.id, response.status);
    },
  };
}

export interface CapturingMailer extends Mailer {
  /** Every message sent since the last `clear()`, oldest first. */
  readonly messages: readonly MailMessage[];
  /** The most recent message to an address, optionally of one kind. */
  latestFor(to: string, tag?: MailMessage['tag']): MailMessage | undefined;
  clear(): void;
}

/**
 * The capturing implementation (17.1, 21.5).
 *
 * Also used in local development, where sending real mail to a real inbox to
 * click a link is friction with no benefit — the link is read from
 * `/api/test/mailbox`, a route that exists only when `NODE_ENV` is `test`.
 */
export function createCapturingMailer(): CapturingMailer {
  const messages: MailMessage[] = [];

  return {
    id: 'capturing',
    messages,
    send(message: MailMessage): Promise<void> {
      messages.push(message);
      return Promise.resolve();
    },
    latestFor(to: string, tag?: MailMessage['tag']): MailMessage | undefined {
      const address = to.trim().toLowerCase();
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index] as MailMessage;
        if (message.to.trim().toLowerCase() !== address) continue;
        if (tag !== undefined && message.tag !== tag) continue;
        return message;
      }
      return undefined;
    },
    clear(): void {
      messages.length = 0;
    },
  };
}

/** Where mail may be captured instead of sent: a dev server, or a test build. */
export function allowsCapturedMail(env: NodeJS.ProcessEnv = process.env): boolean {
  return areTestEndpointsEnabled(env) || env.NODE_ENV === 'development';
}

/**
 * The process-wide capturing mailer. A module-level instance rather than one
 * per request, because the thing reading it (a test, through the mailbox route)
 * is a different request from the one that sent the message.
 */
let sharedCapturingMailer: CapturingMailer | undefined;

export function capturingMailer(): CapturingMailer {
  sharedCapturingMailer ??= createCapturingMailer();
  return sharedCapturingMailer;
}

/**
 * Build the mailer for the current environment (17.1, 22.2).
 *
 * With a provider configured, mail is sent. Without one, the capturing mailer
 * is used — but only where capture is explicitly allowed: a development server,
 * or a build with the test endpoints enabled. Any other deployment refuses to
 * start rather than silently swallowing verification mail, because an
 * installation that does that looks perfectly healthy while nobody can sign in.
 *
 * The condition is deliberately not "NODE_ENV is not production": a Next.js
 * standalone server sets `NODE_ENV=production` on itself, so that test would
 * pass in a real deployment and fail in the end-to-end suite — exactly
 * backwards.
 */
export function createMailerFromEnv(env: NodeJS.ProcessEnv = process.env): Mailer {
  const apiKey = env['EMAIL_API_KEY'];
  const from = env['EMAIL_FROM'];
  const endpoint = env['EMAIL_API_URL'] ?? 'https://api.resend.com/emails';

  if (apiKey === undefined || apiKey === '' || from === undefined || from === '') {
    if (!allowsCapturedMail(env)) {
      throw new Error(
        'EMAIL_API_KEY and EMAIL_FROM must be set: without them no verification or reset email can be delivered.',
      );
    }
    return capturingMailer();
  }

  return createHttpMailer({
    id: env['EMAIL_PROVIDER_ID'] ?? 'http',
    endpoint,
    apiKey,
    from,
  });
}
