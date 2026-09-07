'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { authInput } from '@vaultide/validation';
import { authClient } from '@/lib/auth-client';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useHydrated } from '@/lib/use-hydrated';
import { Section, Status } from './settings-forms';

/**
 * Security settings (blueprint 15.2 "security (password, 2FA, sessions)",
 * 17.1, 18.3).
 *
 * Three sensitive operations live here, and each re-authenticates with the
 * password. Better Auth also enforces `freshAge` on these endpoints, so a
 * session older than ten minutes cannot perform them on the strength of the
 * cookie alone — the password is what makes it work either way (17.1).
 *
 * Backup codes are shown **once**, at the moment they are generated. Vaultide
 * stores them encrypted and cannot show them again; saying so plainly is the
 * difference between a user who keeps them and one who is locked out.
 */

function messageOf(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return fallback;
}

function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  hint,
  testId,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  hint?: string;
  testId?: string;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="password"
        value={value}
        autoComplete={autoComplete}
        data-testid={testId}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      {hint === undefined ? null : (
        <p className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">{hint}</p>
      )}
    </div>
  );
}

export function ChangePasswordForm() {
  // See `useHydrated`: a controlled form is not usable until React owns it.
  const hydrated = useHydrated();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  return (
    <Section
      title="Password"
      description="Changing your password signs you out on every other device."
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          setDone(false);

          const parsed = authInput.password.safeParse(next);
          if (!parsed.success) {
            setError(parsed.error.issues[0]?.message ?? 'Check the password.');
            return;
          }

          startTransition(async () => {
            const result = await authClient.changePassword({
              currentPassword: current,
              newPassword: parsed.data,
              revokeOtherSessions: true,
            });
            if (result.error) {
              setError(messageOf(result.error, 'That did not work.'));
              return;
            }
            setCurrent('');
            setNext('');
            setDone(true);
          });
        }}
      >
        <PasswordField
          label="Current password"
          value={current}
          onChange={setCurrent}
          autoComplete="current-password"
          testId="current-password"
        />
        <PasswordField
          label="New password"
          value={next}
          onChange={setNext}
          autoComplete="new-password"
          testId="new-password"
          hint={`At least ${String(authInput.MIN_PASSWORD_LENGTH)} characters. Passwords found in public breaches are refused.`}
        />
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={!hydrated || pending}
            className="rounded-[var(--radius-control)] bg-[var(--color-accent)] px-4 py-2 font-medium text-[var(--color-accent-foreground)] disabled:opacity-60"
          >
            {pending ? 'Changing…' : 'Change password'}
          </button>
          {error === null ? null : <Status tone="error">{error}</Status>}
          {done ? <Status tone="success">Password changed.</Status> : null}
        </div>
      </form>
    </Section>
  );
}

export function TwoFactorSettings({ enabled }: { enabled: boolean }) {
  const hydrated = useHydrated();
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [uri, setUri] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  return (
    <Section
      title="Two-factor authentication"
      description="Optional. With it on, signing in needs a six-digit code from your authenticator app as well as your password."
    >
      {error === null ? null : <Status tone="error">{error}</Status>}
      {done === null ? null : <Status tone="success">{done}</Status>}

      <p data-testid="two-factor-state" className="text-[length:var(--text-meta)]">
        Status: <strong>{enabled ? 'on' : 'off'}</strong>
      </p>

      {enabled ? (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            setDone(null);
            startTransition(async () => {
              const result = await authClient.twoFactor.disable({ password });
              if (result.error) {
                setError(messageOf(result.error, 'That password was not accepted.'));
                return;
              }
              setPassword('');
              setDone('Two-factor authentication is off.');
              router.refresh();
            });
          }}
        >
          <PasswordField
            label="Confirm your password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            testId="totp-password"
          />
          <button
            type="submit"
            disabled={!hydrated || pending}
            data-testid="disable-2fa"
            className="rounded-[var(--radius-control)] border px-4 py-2 font-medium disabled:opacity-60"
          >
            {pending ? 'Turning off…' : 'Turn off two-factor authentication'}
          </button>
        </form>
      ) : uri === null ? (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            setDone(null);
            startTransition(async () => {
              const result = await authClient.twoFactor.enable({ password });
              if (result.error) {
                setError(messageOf(result.error, 'That password was not accepted.'));
                return;
              }
              const data = result.data as { totpURI: string; backupCodes: string[] };
              setUri(data.totpURI);
              setSecret(new URL(data.totpURI).searchParams.get('secret'));
              setBackupCodes(data.backupCodes);
              setPassword('');
            });
          }}
        >
          <PasswordField
            label="Confirm your password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            testId="totp-password"
          />
          <button
            type="submit"
            disabled={!hydrated || pending}
            data-testid="enable-2fa"
            className="rounded-[var(--radius-control)] bg-[var(--color-accent)] px-4 py-2 font-medium text-[var(--color-accent-foreground)] disabled:opacity-60"
          >
            {pending ? 'Preparing…' : 'Set up two-factor authentication'}
          </button>
        </form>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            startTransition(async () => {
              const result = await authClient.twoFactor.verifyTotp({ code: code.trim() });
              if (result.error) {
                setError(messageOf(result.error, 'That code was not accepted.'));
                return;
              }
              setUri(null);
              setSecret(null);
              setCode('');
              setDone('Two-factor authentication is on.');
              router.refresh();
            });
          }}
        >
          <div className="space-y-2 rounded-[var(--radius-surface)] border p-3">
            <p className="text-[length:var(--text-meta)]">
              Add this secret to your authenticator app, then enter the code it shows.
            </p>
            <code data-testid="totp-secret" className="block break-all text-[length:var(--text-meta)]">
              {secret}
            </code>
          </div>

          {backupCodes === null ? null : (
            <div className="space-y-2 rounded-[var(--radius-surface)] border border-[var(--color-warning)] p-3">
              <p className="text-[length:var(--text-meta)]">
                <strong>Save these backup codes now.</strong> Each works once, in place of a code
                from your app. Vaultide stores them encrypted and cannot show them again.
              </p>
              <ul data-testid="backup-codes" className="grid gap-1 sm:grid-cols-2">
                {backupCodes.map((backupCode) => (
                  <li key={backupCode} className="tabular text-[length:var(--text-meta)]">
                    {backupCode}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="totp-confirm">Code from your app</Label>
            <Input
              id="totp-confirm"
              value={code}
              inputMode="numeric"
              autoComplete="one-time-code"
              data-testid="totp-code"
              onChange={(event) => {
                setCode(event.target.value);
              }}
            />
          </div>

          <button
            type="submit"
            disabled={!hydrated || pending}
            data-testid="confirm-2fa"
            className="rounded-[var(--radius-control)] bg-[var(--color-accent)] px-4 py-2 font-medium text-[var(--color-accent-foreground)] disabled:opacity-60"
          >
            {pending ? 'Confirming…' : 'Confirm and turn on'}
          </button>
        </form>
      )}
    </Section>
  );
}

/**
 * Account deletion (18.3): re-authenticate, type the confirmation, then every
 * row the account owns is removed by the database's own cascade.
 */
export function DeleteAccountForm() {
  const hydrated = useHydrated();
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const phrase = authInput.DELETE_ACCOUNT_CONFIRMATION;

  return (
    <Section
      title="Delete your account"
      description="Permanent. Your settings, categories, tags and every financial record are deleted from the live database immediately. Encrypted backups taken before now expire on their own schedule and are never restored selectively."
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);

          const parsed = authInput.deleteAccountInput.safeParse({ password, confirmation });
          if (!parsed.success) {
            setError(parsed.error.issues[0]?.message ?? 'Check the form.');
            return;
          }

          startTransition(async () => {
            const result = await authClient.deleteUser({ password: parsed.data.password });
            if (result.error) {
              setError(messageOf(result.error, 'That password was not accepted.'));
              return;
            }
            router.push('/');
            router.refresh();
          });
        }}
      >
        <PasswordField
          label="Confirm your password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          testId="delete-password"
        />
        <div className="space-y-1.5">
          <Label htmlFor="delete-confirmation">Type {phrase} to confirm</Label>
          <Input
            id="delete-confirmation"
            value={confirmation}
            data-testid="delete-confirmation"
            autoComplete="off"
            onChange={(event) => {
              setConfirmation(event.target.value);
            }}
          />
        </div>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={!hydrated || pending}
            data-testid="delete-account"
            className="rounded-[var(--radius-control)] border border-[var(--color-negative)] px-4 py-2 font-medium text-[var(--color-negative)] disabled:opacity-60"
          >
            {pending ? 'Deleting…' : 'Delete my account permanently'}
          </button>
          {error === null ? null : <Status tone="error">{error}</Status>}
        </div>
      </form>
    </Section>
  );
}
