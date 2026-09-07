import { z } from 'zod';

/**
 * Authentication inputs (blueprint 17.1, 17.3, 20.1).
 *
 * These schemas are the client's immediate feedback. They are **not** the
 * authority: Better Auth applies its own `minPasswordLength` / `maxPasswordLength`
 * and its Have I Been Pwned check on the server, so a bypassed client gains
 * nothing. Keeping the numbers here identical means the user is told the rule
 * before they submit rather than after.
 */

/** 17.1: `minPasswordLength: 12`. */
export const MIN_PASSWORD_LENGTH = 12;
/** 17.1: `maxPasswordLength: 128`. */
export const MAX_PASSWORD_LENGTH = 128;

export const email = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .pipe(z.email('Enter a valid email address.'));

export const password = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Use at least ${String(MIN_PASSWORD_LENGTH)} characters.`)
  .max(MAX_PASSWORD_LENGTH, `Use at most ${String(MAX_PASSWORD_LENGTH)} characters.`);

/** A person's display name. Never used for identification. */
export const displayName = z
  .string()
  .trim()
  .min(1, 'Enter your name.')
  .max(120, 'That name is too long.');

export const signUpInput = z.object({
  name: displayName,
  email,
  password,
});

export const signInInput = z.object({
  email,
  password: z.string().min(1, 'Enter your password.'),
  rememberMe: z.boolean().default(true),
});

export const requestPasswordResetInput = z.object({ email });

export const resetPasswordInput = z.object({
  token: z.string().min(1),
  password,
});

/** A six-digit TOTP code, or a backup code, as typed. */
export const totpCode = z
  .string()
  .trim()
  .regex(/^\d{6}$/u, 'Enter the six-digit code from your authenticator app.');

export const backupCode = z.string().trim().min(1, 'Enter a backup code.');

/**
 * Account deletion (18.3): the user re-authenticates with their password **and**
 * types the confirmation phrase. Both are required; neither alone is enough,
 * and the server additionally requires a fresh session (17.1 `freshAge`).
 */
export const DELETE_ACCOUNT_CONFIRMATION = 'DELETE MY ACCOUNT';

export const deleteAccountInput = z.object({
  password: z.string().min(1, 'Enter your password to confirm.'),
  confirmation: z.literal(
    DELETE_ACCOUNT_CONFIRMATION,
    `Type ${DELETE_ACCOUNT_CONFIRMATION} exactly to confirm.`,
  ),
});

export type SignUpInput = z.infer<typeof signUpInput>;
export type SignInInput = z.infer<typeof signInInput>;
export type ResetPasswordInput = z.infer<typeof resetPasswordInput>;
export type DeleteAccountInput = z.infer<typeof deleteAccountInput>;
