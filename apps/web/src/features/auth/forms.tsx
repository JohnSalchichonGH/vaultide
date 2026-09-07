'use client';

import { useId, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useRouter, useSearchParams } from 'next/navigation';
import { authInput } from '@vaultide/validation';
import { authClient } from '@/lib/auth-client';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { useHydrated } from '@/lib/use-hydrated';

/**
 * The authentication forms (blueprint 15.2, 16.6, 17.3, 20.1).
 *
 * Client components, because they talk to `/api/auth/*` and need to show a
 * result. Three rules shape them all:
 *
 *  - the client's validation is the same Zod schema the server applies, so the
 *    user is told the rule before they submit rather than after, and bypassing
 *    the form changes nothing (20.1);
 *  - sign-up and password reset say the same thing whether or not the address
 *    exists (17.3 "Enumeration"): the interface must not become the oracle the
 *    API refuses to be;
 *  - errors are announced (`role="alert"`, `aria-describedby`) and every field
 *    has a visible label (16.6).
 */

function messageOf(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return fallback;
}

export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-md">
      <h1 className="text-[length:var(--text-page)] font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-[var(--color-muted-foreground)]">{description}</p>
      <div className="mt-6 space-y-4">{children}</div>
      {footer === undefined ? null : (
        <div className="mt-6 border-t pt-4 text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
          {footer}
        </div>
      )}
    </div>
  );
}

export function SubmitButton({
  children,
  pending,
  disabled,
}: {
  children: ReactNode;
  pending: boolean;
  disabled?: boolean;
}) {
  // Disabled until React has taken the form over: before that a click runs no
  // handler at all, and anything typed is discarded on the first render.
  const hydrated = useHydrated();
  return (
    <button
      type="submit"
      disabled={!hydrated || pending || disabled === true}
      className="w-full rounded-[var(--radius-control)] bg-[var(--color-accent)] px-4 py-2.5 font-medium text-[var(--color-accent-foreground)] disabled:opacity-60"
    >
      {pending ? 'Working…' : children}
    </button>
  );
}

function Notice({ tone, children }: { tone: 'error' | 'success' | 'info'; children: ReactNode }) {
  const color =
    tone === 'error'
      ? 'var(--color-negative)'
      : tone === 'success'
        ? 'var(--color-positive)'
        : 'var(--color-info)';
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      data-testid={`auth-${tone}`}
      className="rounded-[var(--radius-control)] border px-3 py-2 text-[length:var(--text-meta)]"
      style={{ color, borderColor: color }}
    >
      {children}
    </p>
  );
}

function Field({
  label,
  type,
  name,
  value,
  onChange,
  autoComplete,
  hint,
  error,
  required = true,
}: {
  label: string;
  type: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
}) {
  const id = useId();
  const describedBy = `${id}-hint`;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={name}
        type={type}
        value={value}
        required={required}
        autoComplete={autoComplete}
        aria-invalid={error != null}
        aria-describedby={error != null || hint !== undefined ? describedBy : undefined}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      {error != null || hint !== undefined ? (
        <p
          id={describedBy}
          role={error != null ? 'alert' : undefined}
          className={cn(
            'text-[length:var(--text-meta)]',
            error != null ? 'text-[var(--color-negative)]' : 'text-[var(--color-muted-foreground)]',
          )}
        >
          {error ?? hint}
        </p>
      ) : null}
    </div>
  );
}

export function SignUpForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);

    const parsed = authInput.signUpInput.safeParse({ name, email, password });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the form.');
      return;
    }

    setPending(true);
    const result = await authClient.signUp.email({
      name: parsed.data.name,
      email: parsed.data.email,
      password: parsed.data.password,
    });
    setPending(false);

    if (result.error) {
      // A compromised or too-short password is a real, actionable message; an
      // "email already registered" is not one Better Auth returns, by design.
      setError(messageOf(result.error, 'Could not create the account.'));
      return;
    }
    setSubmitted(true);
  }

  if (submitted) {
    return (
      <AuthCard
        title="Check your email"
        description={
          <>
            If <strong>{email}</strong> can receive mail, a confirmation link is on its way. It is
            valid for one hour and can be used once.
          </>
        }
        footer={
          <>
            The message never arrived?{' '}
            <Link className="underline" href="/sign-in">
              Try signing in
            </Link>{' '}
            — you may already have an account with this address.
          </>
        }
      >
        <Notice tone="success">Account created if this address was not already registered.</Notice>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Create your Vaultide account"
      description="Vaultide keeps every record in its native currency and never shows a number it cannot justify."
      footer={
        <>
          Already have an account?{' '}
          <Link className="underline" href="/sign-in">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={(event) => void onSubmit(event)} className="space-y-4" noValidate>
        {error === null ? null : <Notice tone="error">{error}</Notice>}
        <Field label="Your name" type="text" name="name" value={name} onChange={setName} autoComplete="name" />
        <Field
          label="Email address"
          type="email"
          name="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
        />
        <Field
          label="Password"
          type="password"
          name="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          hint={`At least ${String(authInput.MIN_PASSWORD_LENGTH)} characters. Passwords found in public breaches are refused.`}
        />
        <SubmitButton pending={pending}>Create account</SubmitButton>
      </form>
    </AuthCard>
  );
}

export function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get('next');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [needsSecondFactor, setNeedsSecondFactor] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function land(): void {
    // Only a same-site path is honoured: `?next=https://elsewhere` would be an
    // open redirect, and a leading `//` is a protocol-relative URL (17.3).
    const safe =
      next !== null && next.startsWith('/') && !next.startsWith('//')
        ? (next as Route)
        : ('/onboarding/1' as Route);
    router.push(safe);
    router.refresh();
  }

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setPending(true);

    const result = await authClient.signIn.email({ email: email.trim().toLowerCase(), password });
    setPending(false);

    if (result.error) {
      setError(
        messageOf(
          result.error,
          'Those details did not match an account, or the address has not been confirmed yet.',
        ),
      );
      return;
    }

    // 17.1: with 2FA on, sign-in stops here and no session is issued until the
    // second factor is verified.
    if ((result.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect === true) {
      setNeedsSecondFactor(true);
      return;
    }
    land();
  }

  async function onVerify(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setPending(true);

    const result = useBackupCode
      ? await authClient.twoFactor.verifyBackupCode({ code: code.trim() })
      : await authClient.twoFactor.verifyTotp({ code: code.trim() });
    setPending(false);

    if (result.error) {
      setError(messageOf(result.error, 'That code was not accepted.'));
      return;
    }
    land();
  }

  if (needsSecondFactor) {
    return (
      <AuthCard
        title="Two-factor code"
        description={
          useBackupCode
            ? 'Enter one of the backup codes you saved. Each can be used once.'
            : 'Enter the six-digit code from your authenticator app.'
        }
      >
        <form onSubmit={(event) => void onVerify(event)} className="space-y-4" noValidate>
          {error === null ? null : <Notice tone="error">{error}</Notice>}
          <Field
            label={useBackupCode ? 'Backup code' : 'Authentication code'}
            type="text"
            name="code"
            value={code}
            onChange={setCode}
            autoComplete="one-time-code"
          />
          <SubmitButton pending={pending}>Verify</SubmitButton>
          <button
            type="button"
            className="w-full text-[length:var(--text-meta)] underline"
            onClick={() => {
              setUseBackupCode((current) => !current);
              setCode('');
              setError(null);
            }}
          >
            {useBackupCode ? 'Use my authenticator app instead' : 'Use a backup code instead'}
          </button>
        </form>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Sign in to Vaultide"
      description="Your session lasts 30 days on this device."
      footer={
        <div className="flex items-center justify-between gap-4">
          <Link className="underline" href="/reset">
            Forgot your password?
          </Link>
          <Link className="underline" href="/sign-up">
            Create an account
          </Link>
        </div>
      }
    >
      <form onSubmit={(event) => void onSubmit(event)} className="space-y-4" noValidate>
        {error === null ? null : <Notice tone="error">{error}</Notice>}
        <Field
          label="Email address"
          type="email"
          name="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
        />
        <Field
          label="Password"
          type="password"
          name="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />
        <SubmitButton pending={pending}>Sign in</SubmitButton>
      </form>
    </AuthCard>
  );
}

export function RequestResetForm() {
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setPending(true);

    const result = await authClient.requestPasswordReset({
      email: email.trim().toLowerCase(),
      redirectTo: `${window.location.origin}/reset`,
    });
    setPending(false);

    // 17.3: the answer is the same whether or not the address exists. Only a
    // rate limit or an outage produces an error here.
    if (result.error) {
      setError(messageOf(result.error, 'Too many attempts. Try again in a few minutes.'));
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <AuthCard
        title="Check your email"
        description="If that address has a Vaultide account, a reset link is on its way. It is valid for one hour and can be used once."
        footer={
          <Link className="underline" href="/sign-in">
            Back to sign in
          </Link>
        }
      >
        <Notice tone="success">Reset link sent if the address is registered.</Notice>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Reset your password"
      description="We will email you a single-use link. Resetting your password signs you out everywhere else."
      footer={
        <Link className="underline" href="/sign-in">
          Back to sign in
        </Link>
      }
    >
      <form onSubmit={(event) => void onSubmit(event)} className="space-y-4" noValidate>
        {error === null ? null : <Notice tone="error">{error}</Notice>}
        <Field
          label="Email address"
          type="email"
          name="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
        />
        <SubmitButton pending={pending}>Send reset link</SubmitButton>
      </form>
    </AuthCard>
  );
}

export function ChooseNewPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);

    const parsed = authInput.password.safeParse(password);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the password.');
      return;
    }

    setPending(true);
    const result = await authClient.resetPassword({ token, newPassword: parsed.data });
    setPending(false);

    if (result.error) {
      setError(
        messageOf(result.error, 'That link has expired or has already been used. Request a new one.'),
      );
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <AuthCard
        title="Password changed"
        description="Every other session has been signed out. Sign in with your new password."
      >
        <Notice tone="success">Your password has been changed.</Notice>
        <button
          type="button"
          onClick={() => {
            router.push('/sign-in');
          }}
          className="w-full rounded-[var(--radius-control)] bg-[var(--color-accent)] px-4 py-2.5 font-medium text-[var(--color-accent-foreground)]"
        >
          Go to sign in
        </button>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Choose a new password"
      description="This link can be used once. Setting a new password signs you out on every other device."
    >
      <form onSubmit={(event) => void onSubmit(event)} className="space-y-4" noValidate>
        {error === null ? null : <Notice tone="error">{error}</Notice>}
        <Field
          label="New password"
          type="password"
          name="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          hint={`At least ${String(authInput.MIN_PASSWORD_LENGTH)} characters. Passwords found in public breaches are refused.`}
        />
        <SubmitButton pending={pending}>Set new password</SubmitButton>
      </form>
    </AuthCard>
  );
}

export { Notice };
