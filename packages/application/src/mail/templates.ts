import type { MailMessage } from './mailer';

/**
 * Message templates (blueprint 17.1: "verification and reset messages name the
 * product"; sender identity and branding are "Vaultide").
 *
 * Deliberately plain: no images, no tracking pixel, no third-party assets. The
 * only variable content is the recipient's own name and a single-use link, and
 * every message says what to do if it was not expected — which is what makes
 * the enumeration-resistant sign-up flow (17.3) honest rather than confusing to
 * the person who receives it.
 */

const PRODUCT = 'Vaultide';

/** Minimal escaping: the only interpolated values are a name and a URL. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

function layout(heading: string, paragraphs: readonly string[], action?: { label: string; url: string }): string {
  const body = paragraphs
    .map((text) => `<p style="margin:0 0 16px">${escapeHtml(text)}</p>`)
    .join('');
  const button =
    action === undefined
      ? ''
      : `<p style="margin:0 0 24px"><a href="${escapeHtml(action.url)}" style="display:inline-block;padding:10px 16px;border-radius:6px;background:#2f4f9b;color:#ffffff;text-decoration:none">${escapeHtml(action.label)}</a></p>` +
        `<p style="margin:0 0 16px;font-size:12px;color:#666">If the button does not work, paste this link into your browser:<br>${escapeHtml(action.url)}</p>`;

  return [
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1f2430;max-width:520px">`,
    `<p style="margin:0 0 24px;font-weight:600;font-size:16px">${PRODUCT}</p>`,
    `<h1 style="margin:0 0 16px;font-size:18px;font-weight:600">${escapeHtml(heading)}</h1>`,
    body,
    button,
    `<p style="margin:24px 0 0;font-size:12px;color:#666">${PRODUCT} — personal finance, reconciled monthly.</p>`,
    `</div>`,
  ].join('');
}

function plain(heading: string, paragraphs: readonly string[], action?: { label: string; url: string }): string {
  return [
    PRODUCT,
    '',
    heading,
    '',
    ...paragraphs,
    ...(action === undefined ? [] : ['', `${action.label}: ${action.url}`]),
    '',
    `${PRODUCT} — personal finance, reconciled monthly.`,
  ].join('\n');
}

export function verificationEmail(input: { to: string; name: string; url: string }): MailMessage {
  const heading = `Confirm your email address`;
  const paragraphs = [
    `Hello ${input.name}, welcome to ${PRODUCT}.`,
    `Confirm this address to finish setting up your account. The link is valid for one hour and can be used once.`,
    `If you did not create a ${PRODUCT} account, ignore this message — nothing was created without this confirmation.`,
  ];
  const action = { label: 'Confirm my email address', url: input.url };
  return {
    to: input.to,
    subject: `Confirm your ${PRODUCT} email address`,
    text: plain(heading, paragraphs, action),
    html: layout(heading, paragraphs, action),
    tag: 'verification',
  };
}

export function resetPasswordEmail(input: { to: string; name: string; url: string }): MailMessage {
  const heading = 'Reset your password';
  const paragraphs = [
    `Hello ${input.name}.`,
    `Use the link below to choose a new ${PRODUCT} password. It is valid for one hour and can be used once.`,
    `Resetting your password signs you out everywhere else, on every device.`,
    `If you did not ask for this, you can ignore the message — your password has not changed.`,
  ];
  const action = { label: 'Choose a new password', url: input.url };
  return {
    to: input.to,
    subject: `Reset your ${PRODUCT} password`,
    text: plain(heading, paragraphs, action),
    html: layout(heading, paragraphs, action),
    tag: 'reset-password',
  };
}

/**
 * Sent to the **existing** owner when somebody tries to sign up with their
 * address (17.3 "Enumeration"). The person doing the signing up is told the
 * same thing either way, so this message is what makes the flow safe rather
 * than merely opaque: the real owner learns of the attempt.
 */
export function existingAccountSignUpEmail(input: {
  to: string;
  name: string;
  signInUrl: string;
  resetUrl: string;
}): MailMessage {
  const heading = `Someone tried to sign up with this address`;
  const paragraphs = [
    `Hello ${input.name}.`,
    `A ${PRODUCT} account already exists for this email address, and someone just tried to create another one with it. No second account was created and nothing about your account changed.`,
    `If it was you, sign in instead: ${input.signInUrl}`,
    `If it was not you and you cannot sign in, reset your password: ${input.resetUrl}`,
  ];
  const action = { label: 'Sign in', url: input.signInUrl };
  return {
    to: input.to,
    subject: `A ${PRODUCT} account already exists for this address`,
    text: plain(heading, paragraphs, action),
    html: layout(heading, paragraphs, action),
    tag: 'existing-account-signup',
  };
}

/** Sent once the account and all its data are gone (18.3). */
export function accountDeletedEmail(input: { to: string; name: string }): MailMessage {
  const heading = 'Your account has been deleted';
  const paragraphs = [
    `Hello ${input.name}.`,
    `Your ${PRODUCT} account and every financial record in it have been permanently deleted. Nothing remains in the live database.`,
    `Encrypted backups taken before the deletion expire on their own schedule and are never restored selectively; after that no copy of your data exists.`,
    `If you did not ask for this, reply to this message immediately.`,
  ];
  return {
    to: input.to,
    subject: `Your ${PRODUCT} account has been deleted`,
    text: plain(heading, paragraphs),
    html: layout(heading, paragraphs),
    tag: 'account-deleted',
  };
}
