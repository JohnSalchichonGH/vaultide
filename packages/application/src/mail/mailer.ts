/**
 * The `Mailer` abstraction (blueprint 17.1).
 *
 * Vaultide sends exactly four kinds of message, all of them transactional and
 * all of them a consequence of something the account holder just did. There is
 * no marketing path, no list and no unsubscribe state to keep.
 *
 * The interface exists so the provider is one file and the tests never send
 * anything: the E2E and integration suites use the capturing implementation and
 * read the verification link out of it (21.5).
 *
 * **Nothing here is ever logged.** A verification or reset email body contains a
 * single-use credential; 18.2 keeps request payloads out of logs and Sentry, and
 * that applies to these messages in full — subject, body and recipient.
 */

export interface MailMessage {
  /** A single recipient. Vaultide never sends to more than one person at a time. */
  readonly to: string;
  readonly subject: string;
  /** Plain text is always sent: some clients never render the HTML part. */
  readonly text: string;
  readonly html: string;
  /** Provider-side grouping, e.g. `verification`. Carries no user data. */
  readonly tag: MailTag;
}

export type MailTag =
  | 'verification'
  | 'reset-password'
  | 'existing-account-signup'
  | 'account-deleted';

export interface Mailer {
  /** Identifies the implementation in operational logs — never the message. */
  readonly id: string;
  send(message: MailMessage): Promise<void>;
}

export class MailDeliveryError extends Error {
  readonly code = 'MAIL_DELIVERY_FAILED';
  constructor(
    readonly providerId: string,
    readonly status: number | undefined,
  ) {
    // The provider's response body may echo the recipient address, so only the
    // status code crosses into the message.
    super(
      status === undefined
        ? `The ${providerId} mail provider could not be reached.`
        : `The ${providerId} mail provider answered ${String(status)}.`,
    );
    this.name = 'MailDeliveryError';
  }
}
