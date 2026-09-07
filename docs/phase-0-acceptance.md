# Phase 0 acceptance record

Evidence for every acceptance criterion in blueprint §25 (Phase 0) and §26.
Recorded at commit `6017441`, 2026-09-07. Phase 1 has not been started.

Run identifiers below are GitHub Actions runs in `JohnSalchichonGH/vaultide`.

---

## §26 — Phase 0 gate

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | CI green | **PASS** | Run `34121565676` on `6017441`: lint/boundaries/types, unit and property tests, fresh database + roles + backup, build + end-to-end — all four green. |
| 2 | The shell renders | **PASS** | `e2e/tests/smoke.spec.ts` → *renders the application shell*; 7 specs across `desktop-chromium`, `desktop-webkit` and `mobile-chromium` = 21 passing assertions per CI run. |
| 3 | `"12345678901234567.89"` formats exactly in three locales | **PASS** | `packages/finance/test/unit/format.test.ts` — digit-for-digit comparison in every required locale, output pinned for `en-US`, `de-DE` and `ja-JP`, and the Intl string path proven identical to the fallback assembler. Also asserted in a real browser by the E2E suite. |
| 4 | A 4-minor-unit currency (CLF) round-trips input, storage and display | **PASS** | `format.test.ts:110` (`38123.4567` in, stored, displayed), `money.test.ts` rounding and `fitsMinorUnits`, `packages/db` seed carrying `minor_units = 4`, and the E2E test *round-trips a four-minor-unit currency through the money input*. |
| 5 | `0.1 + 0.2 = 0.3` in `Money` | **PASS** | `money.test.ts:30` — exact via the decimal backend, with `numeric-backends.test.ts` demonstrating that the float backend is *not* exact, which is why money never uses it. |
| 6 | Both numeric backends agree | **PASS** | `numeric-backends.test.ts`: agreement within 0.01 across a 120-month deterministic run, byte-identical output for identical inputs, and an identical ten-method contract. |
| 7 | Fresh database provisioned from scratch (bootstrap → migrate → role assertions) | **PASS** | CI job *Fresh database, roles and backup*. `app_user` is refused every form of DDL, cannot grant itself anything or become another role, and cannot disable RLS; `app_backup` reads every tenant's rows but is refused every write; re-running the bootstrap changes nothing. |
| 8 | Deploy pipeline exercised | **PASS** | Deploy run on `6017441` succeeded; `https://vaultide.vercel.app/api/health` reports `{"status":"ok","database":"ok","version":"6017441"}` — the live commit equals `main`. Vercel's own auto-deploy is suppressed and was verified empirically to stay suppressed. |
| 9 | Verified backup dump as `app_backup` | **PASS** | Run `34121850384`: dumped as `app_backup`, every table's row count matched the live database, encrypted with age, uploaded to the EU-jurisdiction R2 bucket, then **read back out of the bucket** and its sha256 matched the digest taken at encryption time. |

## Operational gaps closed in this session

| Gap | Status | Evidence |
|---|---|---|
| Real GitHub remote and real CI execution | **PASS** | Public repository, CI green on every commit on `main`. |
| Real Neon environment in Frankfurt | **PASS** | Project on `aws-eu-central-1`; three roles bootstrapped through the manual workflow; 20 live assertions as `app_owner` and 22 as `app_backup` pass in `verify-environment.yml` (run `34122055729`). |
| Real Vercel deployment and deploy-hook flow | **PASS** | Project in `fra1`; migrations run before the hook fires; the health gate waits for the specific released commit rather than accepting whatever was already serving. |
| Real Sentry EU project | **PASS** | Events ingested at `ingest.de.sentry.io`; 14 scrubbing assertions pass against the real `scrubEvent` before anything is sent; a stored event confirms no balances, query string, cookies, request body, email or IP survived. Cron monitor checks in `202`. |
| External encrypted backup destination, one verified real backup | **PASS** | Cloudflare R2 `vaultide-backups-prod`, jurisdiction **European Union** (endpoint host carries `.eu.`), 30-day lifecycle rule, bucket-scoped Object Read & Write token. |

## What the first real runs caught

Provisioning against real managed services — rather than assuming they behave like a local
superuser cluster — surfaced defects that neither the local environment nor CI could have found.
Each is fixed and covered:

- `ALTER ROLE` naming `SUPERUSER`/`BYPASSRLS` is refused on managed Postgres; and a `CREATEROLE`
  admin is auto-granted `ADMIN TRUE, SET FALSE`, so membership is not enough to `SET ROLE`.
  Reproduced in `packages/db/test/integration/managed-postgres.test.ts`.
- `information_schema.role_table_grants` only shows grants involving roles the caller belongs to,
  so cross-role verification uses `has_table_privilege`.
- `output: 'standalone'` breaks the Vercel adapter; it is now conditional on `VERCEL=1`.
- The deploy health gate passed against the *previous* deployment and would have green-lit a failed
  build. It now waits for the released commit.
- The Sentry cron check-in returned `404` on every request behind a `|| true`, so a monitor meant to
  report a missed backup would have reported one for a backup that had succeeded. Failures are now
  visible warnings, and the request carries a `Content-Length` (Sentry answers `411` without one).
- A redaction test asserted that a log line did not contain `'99'`, which also matches the
  milliseconds in a timestamp — flaky roughly one run in fifty, with redaction working correctly.

## Open items (none blocks the Phase 0 checkpoint)

1. **Credential files still on disk.** `~/.vaultide/age-backup-key.txt`,
   `.secrets.local/cloudflare.txt`, `.secrets.local/neon-admin-url.txt` and
   `.secrets.local/vercel-env.txt`. All are gitignored and none is in the repository, but they
   should be moved into a password manager and deleted. **Losing the age private key makes every
   archive permanently unreadable.**
2. **Sentry IP storage.** Settings → Security & Privacy → *Prevent Storing of IP Addresses*.
   `scrubEvent` removes the `ip_address` we send, but Sentry derives a coarse location from the
   connecting address at ingest, which no client-side rule can reach.
3. **R2 blast radius.** A pre-existing token (`discord-log-parser build token`) holds Admin Read &
   Write on *all* buckets, so it can delete these archives. Encryption protects their contents, not
   their existence.
4. **Neon plan.** Free gives 6 hours of instant-restore history. Blueprint 22.5 wants 7 days before
   real balances exist — a Phase 1 concern, not a Phase 0 one.
5. **Backup content.** The verified dump covers the reference `currencies` data, which is all the
   schema holds in Phase 0. This is what §25 specifies ("against an empty DB"); the dump-count
   verification is what proves completeness, and it is exercised.
