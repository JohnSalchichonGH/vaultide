# Data retention

Blueprint 18.3, 18.4. This is the retention statement the privacy notice points
at. It is written now, in Phase 0, because backups start now.

| Data | Retained | Deleted |
|---|---|---|
| Account, settings, financial records | For the life of the account | Immediately on account deletion (every table cascades from `user`) |
| Audit entries (before/after images) | For the life of the account | With the account |
| Projection runs (cache) | Disposable; pruned after 90 days | Any time |
| FX rates and currencies | Indefinitely — global reference data, tied to no user | Never |
| Application logs | 30 days, with no financial values in them (18.2) | Automatically |
| Sentry events | 90 days, without PII, request payloads or breadcrumbs | Automatically |
| Encrypted backups | 30 daily + 12 monthly | By bucket lifecycle rule |

**Backups keep deleted data until they expire.** There is no selective purge
from an encrypted archive; the privacy notice says so plainly rather than
implying an erasure guarantee the design cannot keep.

Data subject requests map onto product features: access and portability are the
full JSON/CSV export (Phase 7), and erasure is account deletion (Phase 1),
verified by a test that seeds every table for a user, deletes the account and
asserts zero rows remain.

Processors: Vercel (hosting, Frankfurt), Neon (database, Frankfurt), Sentry (EU
region), the transactional email provider (EU region), and the EU object-store
provider for backups.
