# Restore drill log

Blueprint 22.5: a restore is only real once it has been rehearsed. Drills are
quarterly; the first one is a Phase 7 acceptance criterion.

| Date | Environment | Archive | Restored in | Verification | Notes |
|---|---|---|---|---|---|
| _(none yet)_ | | | | | First drill is due in Phase 7. |

Each row records: the archive restored, wall-clock time from "fetch" to
"verified", the outcome of `pnpm db:verify-dump` and the integration suite on
the restored database, and anything that slowed recovery down.
