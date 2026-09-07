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

### 15. Frankfurter v2, one request per central bank

`api.frankfurter.dev` serves two versions and reports their status itself:
`/v1` is **frozen**, kept only for backward compatibility, and `/v2` is
**current**. The blueprint specifies v2 (§17 stack, D11, 10.1) and the
difference is not cosmetic: v1 exposes only the ECB's own reference set —
30 currencies today — while v2 models 84 central banks and 165 current
currencies.

v2's `/v2/rates` **blends** every provider that publishes a pair, filters
outliers by consensus and overrides pegged currencies with their peg. That is a
good default for a chart and the wrong thing to store here: 10.1 requires that
`source` record *which central bank published each rate*, and a blend has no
publisher — every row would be attributed to Frankfurter, which is a
redistributor. (For a pegged currency the blend is also visibly synthetic:
asking with `expand=providers` returns every contributing bank marked
`excluded: true`, the peg having won.)

Asking for one provider at a time — `providers=ECB` — returns *that bank's own
published rate*, rebased to the requested base, with no blend and no peg
override; verified against the live API. So the adapter walks an explicit,
**approved** chain and makes one request per bank:

- **ECB** first — the reference series 10.1 names, daily since 1999-01-04, and
  the preferred `source` on read (`SOURCE_PREFERENCE`, 10.2).
- **BDI** (Banca d'Italia) second — also EUR-pivoted, also daily since
  1999-01-04, and it publishes 151 currencies, a superset of the ECB's. It is
  what carries the supported set beyond the euro area's 30 without reaching for
  a bank whose own pivot is not the euro.

A currency both banks publish becomes two rows differing only in `source`,
which is exactly the shape 10.4 describes. The two requests are issued
concurrently and concatenated in chain order: one bank per request would
otherwise cost the sum of their latencies, and `ensureHistory` runs inside a
user's request, where a first-use backfill asks for a 27-year series.

Two banks is a **policy**, not the extent of what v2 offers, and the
distinction matters for everything below: v2 carries 84 central banks, so what
this chain publishes is deliberately narrower than what Frankfurter publishes.
Both are EUR-pivoted and euro-system, which is what makes the stored pivot
honest rather than re-derived. Widening the chain is a decision with a
migration behind it, not an implementation detail — and Phase 1 does not.

Everything else about the adapter is unchanged from the frozen specification:
EUR pivot, rates read from the response **text** so the publisher's digits
survive, immutable `fx_rates`, `ON CONFLICT DO NOTHING` idempotence, dated and
latest-on-or-before lookup, and refusal rather than a guess when a rate is
missing or implausible.

### 16. `is_fx_supported` is a statement about our sources, not about the API

The flag means **supported for automatic conversion by Vaultide's approved FX
source chain** — for Phase 1, `ECB -> BDI`. It does not mean "exists in
Frankfurter v2", and the two sets genuinely differ. Every count and exclusion
below is scoped to the approved chain.

That is 150 codes, including the EUR pivot. Starting from v2's 165 current
currencies, three groups are excluded:

- **not money** — XAU, XAG, XPT, XPD (metals) and XDR (the IMF's unit of
  account). ISO 4217 lists all five and v2 quotes them, but nobody holds a bank
  account denominated in gold; this is the judgement R28 makes about crypto,
  applied consistently.
- **not ISO 4217** — CNH, GGP, IMP, JEP. None has an ISO numeric code: they are
  a market variant of CNY and three local sterling issues.
- **no current rate from the approved chain** — ANG, BYN, IRR, KPW, MRO, RUB.
  These are current ISO 4217 currencies, and Frankfurter v2 *does* serve
  current rates for several of them from other official providers: the CBR for
  RUB and the NBRB for BYN, among a dozen more each. Those banks are not in
  Vaultide's chain. What has ended is the ECB's and Banca d'Italia's own
  publication — RUB and BYN in early 2022, ANG, IRR and KPW during 2025, MRO in
  2017 — so the honest statement is that *we* have no current rate for them,
  never that none exists.

So a current ISO 4217 currency can sit in the catalogue with
`is_fx_supported = false`. Its amounts still validate and format; it simply
cannot be chosen as a base or reporting currency, because there is no rate from
a source this product converts with (10.5).

Phase 0 seeded 31 currencies as `is_fx_supported`, from the historical ECB
list; **BGN** is the one that has to leave, and it is a genuinely historical
currency rather than a policy exclusion — v2 lists it only under
`?scope=all`, not among the 165 current currencies. Bulgaria adopted the euro
on 2026-01-01, and the ECB's EUR/BGN reference rate ended with 2025. It stays in
the catalogue with `is_fx_supported = false` — historical amounts must still
validate and format — so it can no longer be chosen as a base or reporting
currency (10.5). ANG and MRO are likewise superseded, by XCG and MRU; RUB, BYN,
IRR and KPW are the policy cases described above. CLF and UYW are Chilean and
Uruguayan indexation units that v2 does not carry at all, and they remain the
reason the schema allows four minor units. 6.2 says "no delete": the seed is
159 rows, 150 convertible by the approved chain and 9 retained.

Minor units come from the **ISO 4217** table, with ICU/CLDR used only as a
cross-check; the two disagree on eleven codes, IQD most visibly (ISO 3, CLDR 0),
and the standard wins.

The assumption is now checked rather than carried: `pnpm db:verify-currencies`
drives the real adapter — not a re-implementation of it — against the live
**approved chain**, compares the result with the committed seed, and exits
non-zero on any divergence in either direction. What it verifies is therefore
the committed Vaultide-supported universe against the `ECB -> BDI` policy, not
against every currency available from every Frankfurter provider; a divergence
always means the seed and the policy disagree.
`FxService.reconcileSupportedCurrencies` does the same at runtime. Both
**report**; neither repairs. Adding or removing a currency, or widening the
chain, is a migration and a decision, not a background job's side effect.

---

## Where the blueprint's wording had to be read carefully

### 17. "First use of a currency" means the first dated conversion, not the first preference

10.4 says:

> **On first use of a currency** (a user creates a position, sets a reporting
> currency or favorite in that currency): `ensureHistory(currency, from)` runs
> in that user's request and fetches the full history from `from` (the user's
> earliest financial date − 31 days, or 1999-01-04 when unknown) to today.

Taken literally — preference selection, and `from` = 1999-01-04 because a Phase
1 user has no financial dates — every currency a user picks in settings costs a
27-year daily series **per approved bank**, inside the request that saves the
setting. Measured against the live service: about 14,200 rows, and under the
end-to-end suite's three parallel projects, six concurrent long-range requests
that upstream answers by stalling. Every one of them hit the adapter's 20-second
timeout, the user's save appeared to hang, and the browser matrix failed for a
reason that had nothing to do with Vaultide.

**This is the one place two parts of the blueprint pull against each other**, so
it is recorded rather than quietly resolved:

- 10.4's *trigger* list includes setting a reporting currency or favourite.
- 10.4's *range*, and 10.5's whole posture, are about having rates for
  **dated financial data**: `from` is defined relative to "the user's earliest
  financial date", and a conversion with no rate is `Unavailable` rather than a
  guess. Phase 1 has no positions, valuations or entries at all — §29.1 gives
  it settings, categories and FX plumbing, and the first dated financial record
  arrives in Phase 2.

So "the user's earliest financial date is unknown" is read as *there is dated
data whose start cannot be determined*, not *there is no dated data*. A
preference is not a request to convert anything; it is a statement about how
figures will be shown once there are figures.

**What the code does now.** `ensureHistory(currency, earliestNeededDate?)`:

- **with** an earliest needed date — a dated conversion — fetches from a month
  before it, 10.4's lookback, and never before 1999-01-04;
- **without** one — a base, reporting or favourite currency being chosen —
  fetches only the window the cron maintains (14 days), so the currency is
  convertible now and nothing historical is downloaded on spec.

Everything else 10.4 asks for is untouched: the fetch still happens on first
use, still in the user's request, still once and globally, still swallowing
provider failure, and the rows are still immutable and idempotent. Phase 2's
first dated conversion fetches exactly the rows the literal reading would have
fetched, at the point they are first worth something.

Measured against the live chain afterwards:

```text
preference (no dated need)   ensureHistory(SEK)                316 ms, 22 rows, from 2026-08-24
dated need                   ensureHistory(SEK, 2026-05-10)     39 ms, 192 rows, from 2026-04-09
the same dated need, again                                       2 ms, 0 rows, skipped
three concurrent, one currency                                 637 ms, one fetch, one answer
```

### 18. Concurrent identical backfills are coalesced

A small map of in-flight fetches keyed by currency and range. Three browsers
finishing onboarding at once, or one page issuing several conversions, would
otherwise ask a free public provider the same question simultaneously — the
stampede that upstream answers by stalling every caller.

It is **coalescing, not caching**: an entry lives only while its fetch is in
flight, so nothing is ever answered from a stale result, and the next call
after it settles reads the database as usual. It is a mitigation, not the fix —
the fix is decision 17, which stopped the enormous requests being made at all.

### 19. The browser matrix runs against an FX fixture; the real service is verified separately

`FX_PROVIDER=fixture` swaps in a deterministic publisher — no network, weekdays
only, both approved banks, exact 12-decimal strings — behind the same gate as
the capturing mailer and the test clock (`areTestEndpointsEnabled`), which a
production deployment refuses outright. A production-like server asked for it
and was refused, in the log as `fx_fixture_provider_refused`, while
`/api/test/fx-provider` returned 404.

Nothing was weakened to achieve that: the suite still signs up, verifies,
completes onboarding, picks base and reporting currencies, checks persistence
across a sign-out, asserts crypto and BGN are absent from the picker, and
proves the conversion semantics it proved before. The substitution is at the
same IO boundary the integration suite already substitutes at (10.1), and the
suite asserts the substitution is real rather than assuming it.

Adapter compatibility with the live service is not lost, it is **moved**: `pnpm
test:live` runs one serial suite against Frankfurter v2 —
`GET /v2/currencies` against the committed seed, ECB and BDI pinned and
attributed, exact decimals checked against the raw response body, the current
refresh, idempotence, weekend gaps, and a dated backfill — once, rather than
once per browser project.

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
- **The first-use backfill made the user wait for both banks in turn.** A
  currency chosen during onboarding triggers `ensureHistory`, which asked for a
  27-year daily series; with one request per bank issued sequentially the
  browser waited for the sum of two cold upstream fetches and the onboarding
  end-to-end test timed out. The chain is now fetched concurrently — bounded by
  the slowest bank, not their sum — and the order of the results, which is the
  source preference, is preserved. Found by the E2E suite, not by a unit test:
  only the real API is slow.

  Concurrency was not enough, and the rest of the answer is decisions 17 to 19:
  the request was too large to be made at all on a settings save, and the
  matrix should never have depended on a public service's latency.
- **A stray directory tree.** `packages/db/apps/web/...` was created by a shell
  whose working directory had moved, and dependency-cruiser reported it as a
  real boundary violation (`db` importing `application`). It was a real file,
  not a tool artifact; deleted.
