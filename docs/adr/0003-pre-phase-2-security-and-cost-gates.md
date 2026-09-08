# ADR 0003 — Pre-Phase-2 security and cost gates

**Status:** accepted · **Date:** 2026-09-08 · **Phase:** between 1 and 2

Phase 1 is frozen, deployed and production-verified at `1796717`. This record
covers the operational and security gates closed *before* Phase 2 begins, and
one code-level invariant that Phase 2 must be built on top of. It adds no Phase
2 functionality: no accounts, positions, valuations or net worth.

The blueprint (`docs/implementation-blueprint.md`, frozen v2.1.2) remains
authoritative. Nothing here changes the architecture, the accounting model, the
schema semantics or the roadmap.

---

## 1. Financial mutations authorize against the session store, never the cookie cache

**This is the rule Phase 2 must follow.** Every state-changing financial action —
a valuation, a flow, a balance, an account edit — validates the session against
the DB-backed store. None may be authorized from the five-minute signed cookie
cache.

### Why the rule is needed

17.1 asks for two things that pull against each other: `cookieCache: { maxAge:
300 }` and `revokeSessionsOnPasswordReset: true`. Both are implemented. The
consequence, recorded in ADR 0002 decision 14, is that an *ordinary* session
read can still be answered from the signed cookie for up to five minutes after
the session row is deleted.

Phase 1 production verification observed exactly that boundary rather than
inferring it: after a password reset on another device, the revoked window still
browsed, completed **one ordinary settings write** (favourite currencies) inside
the window, and was refused on the next write once the window lapsed.

For a preference that is an acceptable trade — cheap, reversible, visible to the
account holder. For a balance it is not. Phase 2 introduces the first writes
where a five-minute lag between "revoked" and "cannot act" would matter.

### What exists now

`requireAuthoritativeSession` in `packages/application/src/auth/session.ts`. It
passes Better Auth's own `disableCookieCache` flag, whose documented purpose is
precisely this — the library's contract says the flag exists so that "a
revoked-but-cached session cannot authorize a sensitive action". Using the
library's mechanism rather than querying the `session` table directly keeps
expiry, refresh and revocation semantics in one place.

`apps/web/src/server/context.ts` exposes it to the web app, and
`apps/web/src/server/actions/define.ts` exposes **`financialAction`** — the same
wrapper as `action`, differing only in which session function it obtains its
context from.

**Phase 2 must declare every financial mutation with `financialAction`.**

A separate factory rather than a flag on `action` is deliberate. A boolean
somebody forgets to pass is invisible in review; a financial mutation declared
with the wrong factory is a question any reader can ask. Nothing uses
`financialAction` yet, because Phase 1 has no financial mutations — it exists so
that the first one cannot be written the wrong way.

### What it is not

It is **not** `requireFreshSession`. That asks whether the user authenticated
recently (`session.createdAt` within `freshAge`) and would accept a session
revoked one second after it was created. The two answer different questions and
only one of them is an authorization.

### Proof

`security.test.ts` → *financial writes are authorized against the session store,
not the cookie*: a session is established, its rows are deleted from another
context, and `requireAuthoritativeSession` is refused immediately while Better
Auth's own authoritative read returns `null`. A second case asserts that
`sessionFresh` still reports `true` for the revoked session, so the distinction
above is tested rather than merely described.

The test was checked by weakening the primitive to use the cache: it then fails
with `promise resolved "{ …(13) }" instead of rejecting` — a dead session
authorizing a write, which is the exact defect the rule exists to prevent.

---

## 2. Neon Launch with a 7-day history window

§22.5 wants 7 days of instant restore as backup layer 1. Neon Free provides 6
hours and cannot be configured. §22.7 places Free in the personal phase and
Launch in the public phase, and the runbook says "move to Launch once real
balances exist" — which is Phase 2.

**Done, 2026-09-08:** the project is on **Launch**, region unchanged
(`aws-eu-central-1`, Frankfurt), history window set to **7 days**. Roles,
privileges and connection strings were unaffected — verified by running
`verify-environment.yml` (20 checks as `app_owner`, 22 as `app_backup`) and a
full `nightly-backup.yml` afterwards.

§22.7's "Neon Launch ≈ €19–25/month" is stale: Launch is now usage-based with no
monthly minimum. For this workload — a production dump under 100 KB — the real
figure is a few dollars.

---

## 3. Compute is fixed at 0.25 CU, and that is the main cost control

The autoscaling range was `0.25 ↔ 8 CU`. At $0.106/CU-hour, sustained 8 CU is
roughly $610/month. Nothing in Vaultide needs it: the entire production database
is 97 KB, and 0.25 CU provides ~0.75 GB of cache — about four orders of
magnitude more than the working set.

**Set to a fixed 0.25 CU with scale-to-zero at 5 minutes.** This converts a
variable bill into a hard ceiling of about **$19/month** even if something kept
the compute awake continuously, and realistically $1–2.

Neon's documented caveats about small computes concern working sets that exceed
the cache and autoscaling ranges whose minimum cannot hold the working set.
Neither applies at this size. The connection limit (104 direct, 10,000 pooled)
is two orders of magnitude above §22.4's `pg` Pool of 5.

This stops being obviously right if a later working set approaches ~0.75 GB. The
remedy is one slider, and raising it takes effect immediately.

---

## 4. Cost-abuse posture

The exposure was reviewed before real financial functionality exists.

| Surface | Anonymous | Ceiling |
|---|---|---|
| `/api/health` | yes — one function invocation and one `ping()` per hit, uncached by design (22.6) | Vercel capped by plan; Neon ≤ ~$19/month because compute is fixed |
| `/api/auth/*` | yes — sign-up and reset send mail | DB-backed limits (5 sign-in/min, 3 sign-up/10 min, 3 reset/15 min, 5 TOTP/5 min, 30/min default), and Resend's free tier stops at 100/day |
| `/api/cron/fx-refresh` | no | 404 without the bearer secret |
| `/api/test/*` | no | 404 in production |
| R2 | no | ~3 MB against a 10 GB free tier, no egress fees |

**Vercel Hobby cannot bill:** exceeding included usage pauses the feature for 30
days rather than charging. Spend Management is listed as N/A on Hobby because a
hard cap already exists. DDoS mitigation is on by default.

Confirmed 2026-09-08: a Neon spending alert is set; Resend has no card and no
pay-as-you-go; Sentry's on-demand budget is $0, so it drops events past quota
rather than billing; R2 is on the free tier.

**No CAPTCHA or WAF rules were added.** Vercel already mitigates DDoS, the auth
limits survive cold starts because they are rows, and the residual ceiling is
under $20/month. Challenge infrastructure would be complexity bought against a
small, bounded number — and it would sit on the sign-up path, which is the one
flow that must not become harder.

---

## 5. R2 bucket lock: 30-day retention

Phase 0 recorded that encryption protects the archives' contents but not their
existence: any write-capable credential could delete them. The over-broad
`discord-log-parser` token was deleted during Phase 1's operational pass, but
`vaultide-backup-writer` itself still could.

**A bucket lock rule `retain-30-days` (no prefix, 30 days) is now configured on
`vaultide-backups-prod`.** R2 bucket locks prevent deletion and overwriting,
apply to existing objects as well as new ones, and take precedence over
lifecycle rules — so the 30-daily lifecycle retention still runs, after the lock
expires. Thirty days matches that retention so the two do not fight.

Verified both directions rather than assumed: a full nightly backup ran
afterwards and uploaded, read back and digest-matched normally (locks do not
prevent *creating* objects, and the workflow's keys are timestamped so it never
overwrites), and a dashboard attempt to delete an archived object was refused.

Two consequences are accepted knowingly:

- **The bucket cannot be emptied while any lock rule exists.** Rules must be
  removed first. That is the feature working.
- **Erasure requests meet a 30-day floor.** Not an issue today — there is one
  data subject and the archives are age-encrypted — but it becomes one the
  moment Vaultide has a second account, and §22.5 does not address erasure from
  backups. Carried as a known consideration for whenever that happens.

R2 does not support the S3 object-lock API; bucket locks are the native
mechanism and are sufficient here.

---

## 6. The first restore drill stays in Phase 7

Checked rather than assumed, because pulling it forward would have been easy to
justify and wrong. The blueprint places it in Phase 7 in three places: §22.5
("Drill quarterly … the first drill is a Phase 7 acceptance criterion"), the
Phase 7 testing list ("first restore drill with dump-count verification"), and
the §26 gate table.

**Not a Phase 2 prerequisite.** It stays scheduled. The backup side is proven end
to end — dump, row-count verification against the live database, age encryption,
upload, read-back and digest — but restoring one into a fresh Neon branch has
not been exercised, and that remains true until Phase 7.
