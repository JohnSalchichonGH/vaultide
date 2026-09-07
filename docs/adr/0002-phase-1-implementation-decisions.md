# ADR 0002 — Phase 1 implementation decisions

**Status:** accepted · **Date:** 2026-09-07 · **Phase:** 1

The blueprint (`docs/implementation-blueprint.md`, frozen v2.1.2) is the
authoritative specification. This record covers the implementation-level choices
Phase 1 had to make that the blueprint left open (section 29.1–29.2), the places
where Better Auth 1.7's API differs from the blueprint's wording and the same
behaviour had to be expressed differently, and one finding that contradicts an
assumption in section 22.1. Nothing here changes the architecture, the
accounting model, the schema semantics or the roadmap.

---

## Version choices

### 1. Better Auth 1.7.2, not 1.7.3

D38 and 30.5 say "latest compatible patched stable release within those lines at
implementation time". 1.7.3 was published on 2026-09-06, one day before this
work; `pnpm-workspace.yaml` sets `minimumReleaseAge: 4320` (three days), the
supply-chain control of 17.3. 1.7.2 (2026-08-26) is the latest release that
policy permits. Next.js stays on 16.3.4, unchanged from Phase 0.

---

## Where Better Auth 1.7's API differs from 17.1's wording

The behaviour in each case is the blueprint's; only the expression differs.

### 2. The reset-request route is `/request-password-reset`

17.1's rate-limit table names it `/forget-password`. Better Auth 1.7 calls the
same endpoint `/request-password-reset`. `AUTH_RATE_LIMITS` keys the rule to the
real route name; the limit — three attempts per fifteen minutes — is unchanged,
and a security test asserts the 429.

### 3. HIBP is the `haveIbeenPwned()` plugin, not an `isPasswordCompromised` option

17.1 says "passwords checked against Have I Been Pwned via
`isPasswordCompromised` (k-anonymity)". In 1.7 that is a first-party plugin with
the same mechanism: a five-character SHA-1 prefix is sent, the range comes back,
and the comparison happens locally. It covers sign-up, password change and
password reset. An integration test signs up with a password long enough to pass
the length rule and known to be in the corpus, and asserts the refusal.

### 4. The TOTP lockout is `accountLockout.maxFailedAttempts`

17.1 says "lockout after 5 wrong codes". 1.7 expresses this as an account-level
lockout across challenges and factors, defaulting to 10; it is set to 5.

### 5. Origin and CSRF checking are stated explicitly

Better Auth disables its origin and CSRF checks when `NODE_ENV === 'test'`.
Convenient for a library's own suite, and wrong here: a control that switches
itself off under exactly the conditions it would be tested in has not been
tested, and the difference between environments would be invisible. The config
sets `advanced.disableOriginCheck: false` and `advanced.disableCSRFCheck: false`,
so the behaviour is identical everywhere and the security suite can assert that
a cross-origin sign-in is refused (17.1 "Origins", 17.3 "CSRF").

---

## Decisions inside the space 29.1–29.2 leaves open

### 6. The email provider is a decision, not a dependency — and neither candidate has EU data residency

29.1 leaves "Postmark or Resend with an EU region" to Phase 1, and 18.3 requires
"an email provider with an EU region". **Neither has one.** Postmark
(ActiveCampaign) is US-only and has said it has no plans for an EU region.
Resend's `eu-west-1` is a *sending* region: account data, message metadata and
logs remain in the US.

Rather than pick one and quietly weaken the residency claim, Phase 1 implements
`Mailer` with a **provider-agnostic HTTP adapter**: endpoint, auth header and
payload shape are configuration (`EMAIL_API_URL`, `EMAIL_API_KEY`, `EMAIL_FROM`).
Switching providers is an environment change, not a code change. The default
endpoint is Resend's. The choice, and its residency consequence, is the product
owner's; `docs/ops/environment-setup.md` states what each option means.

What Vaultide sends by email is narrow — a verification link, a reset link, an
"someone tried to sign up with your address" notice and a deletion confirmation
— so the exposure is an address plus the fact that an account exists. That is
real, and it is why this is written down rather than assumed away.

### 7. `EUR`, `UTC` and `en-GB` are the provisioning defaults

Sign-up asks for a name, an address and a password; it does not know where the
person is or what they think in. Onboarding steps 1 and 2 ask. Until then the
defaults are UTC, `en-GB`, and EUR — the FX pivot, the one currency that is
always convertible without a stored rate (10.1), so a brand-new account can
never be in a state where its own base currency has no rates.

Step 1 pre-selects the browser's own time zone where it is one the form offers,
so the common case is a confirmation rather than a search through 400 zones.

### 8. Onboarding completion lives in `user_settings.preferences`

6.1 restricts JSONB to UI preferences; whether a wizard has been completed is
exactly that. It is written with a JSONB merge and deliberately does **not** bump
`version`: finishing a wizard is not a financial edit and must not invalidate a
settings form somebody left open in another tab.

### 9. Provisioning is idempotent and re-checked on every request

Phase 1 requires that "partial provisioning cannot leave an unusable account".
The whole starting state — settings, the default categories including all seven
system kinds, the initial tags — is written in one transaction inside
`withUser`, so RLS validates ownership on the way in and a failure leaves
nothing behind.

One thing a transaction cannot cover: Better Auth commits the `user` row through
its own adapter and calls the provisioning hook afterwards. If the process dies
in between, the account exists un-provisioned. Every write is therefore
`ON CONFLICT DO NOTHING`, and `requireSession` calls `ensureProvisioned` on each
authenticated request — a single indexed primary-key read in the normal case.
Sign-in is verification-gated, so there is no window in which a user can act on
an un-provisioned account. An integration test deletes the settings row and
asserts the next request repairs it.

### 10. Repositories, not Drizzle in the application layer

Section 19 places "typed queries, always user-scoped" in `packages/db`. Phase 1's
first draft had the application services writing Drizzle directly; that would
have made `drizzle-orm` an application dependency and put SQL two layers up from
where the blueprint puts it. All queries moved into
`packages/db/src/repositories/*`, and `packages/db` re-exports the handful of
Drizzle helpers (`sql`, `eq`, …) the integration tests need — which also
guarantees exactly one copy of Drizzle is loaded. Two copies type-check as
unrelated classes and fail at the first `sql` template that crosses a package
boundary.

### 11. The capturing mailer is reachable at `/api/test/mailbox`

21.5 calls for a "capturing mailer" in the E2E suite. The route returns captured
messages and exists **only** when `NODE_ENV === 'test'` — the same gate as the
`TEST_CLOCK` header of section 21 — and answers 404 otherwise. It is also what
makes local development work without a mail provider.

### 12. Time-zone and locale shortlists

29.2 leaves the locale story open and 29.3 defers localization. The settings and
onboarding forms offer every zone the runtime knows (`Intl.supportedValuesOf`),
with the user's current value always present, and a shortlist of locales whose
number formatting differs enough to matter — which is the case 7.1.1 and 16.6
exist for.

---

## Interpreting the blueprint where two sections differ

### 13. Auth pages live at `/sign-in`, not `/auth/sign-in`

15.1 lists the routes as `/auth/(sign-in|sign-up|verify|reset)`; 19 shows the
directory as `src/app/(auth)/sign-in|sign-up|verify|reset/`. In the App Router a
parenthesised directory is a route **group** and does not appear in the URL, so
19's layout — which is the concrete one — yields `/sign-in`. Section 19's file
tree is followed exactly; 15.1's shorthand is read as naming that group.

### 14. Cookie caching leaves a five-minute read window after revocation

17.1 asks for both `cookieCache: { enabled: true, maxAge: 300 }` and
`revokeSessionsOnPasswordReset: true`. Revocation deletes the session rows —
which is what makes it hold on devices this process will never see again — but
for up to five minutes an ordinary `get-session` read can still be answered from
the signed cookie. Every endpoint that *authorizes* something (password change,
2FA changes, account deletion, session revocation) re-reads the store, so a
revoked device cannot act; it can only still be told who it was.

This is the blueprint's own configuration, implemented as written, and it is
recorded here because "sessions are revoked" and "a revoked session can be read
for five more minutes" are both true and the second is not obvious. The security
suite asserts the rows are gone, that an authoritative read returns null, and
that a sensitive endpoint returns 401.

---

## Corrections to Phase 0

### 15. BGN is no longer FX-supported

Phase 0's seed marked 31 currencies `is_fx_supported`, from the historical ECB
list. The provider publishes 30: Bulgaria adopted the euro on 2026-01-01 and the
ECB stopped publishing a EUR/BGN reference rate. BGN stays in the catalogue so
historical amounts still validate and format, with `is_fx_supported = false`, so
it can no longer be chosen as a base or reporting currency — there would be no
rate to convert it with (10.5).

The assumption is now checked rather than carried: `pnpm db:verify-currencies`
compares the committed seed with the provider's own list and exits non-zero on
any divergence in either direction, and `FxService.reconcileSupportedCurrencies`
does the same at runtime. Both **report**; neither repairs. Adding or removing a
currency is a migration and a decision, not a background job's side effect.

---

## Defects found while implementing Phase 1

- **Better Auth's origin check was silently off in tests.** See decision 5. The
  first cross-origin test passed a sign-in it should have refused; the cause was
  `NODE_ENV`, not the configuration, which is precisely why the flags are now
  explicit.
- **`countUserRows` read without a user context.** The deletion verification
  used `withoutUser`, so RLS returned zero rows for every table and an
  unfinished deletion would have looked complete. It now runs inside
  `withUser` — well defined for a deleted user's id, since the policy compares
  the column with the setting and does not care whether that user still exists.
- **A stray directory tree.** `packages/db/apps/web/...` was created by a shell
  whose working directory had moved, and dependency-cruiser reported it as a
  real boundary violation (`db` importing `application`). It was a real file,
  not a tool artifact; deleted.
