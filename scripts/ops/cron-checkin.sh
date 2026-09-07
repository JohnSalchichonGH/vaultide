#!/usr/bin/env bash
#
# Checks in with the Sentry cron monitor that watches the nightly backup
# (blueprint 22.5).
#
#   scripts/ops/cron-checkin.sh in_progress|ok|error
#
# Two rules, learned the hard way. A monitoring problem must never fail a
# backup that actually succeeded — so a bad response is a warning, not an
# error. But it must never be *silent* either: the first version ended in
# `|| true`, and a misconfigured URL returned 404 on every run while the job
# stayed green, so the monitor would have reported a missed check-in for a
# backup that had in fact completed.
set -uo pipefail

status="${1:?usage: cron-checkin.sh in_progress|ok|error}"

if [ -z "${SENTRY_CRON_URL:-}" ]; then
  echo "No cron monitor configured; skipping the ${status} check-in."
  exit 0
fi

# --data '' so the POST carries a Content-Length. Sentry answers 411 without
# one, which is indistinguishable from a real outage at a glance.
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST --data '' \
  "${SENTRY_CRON_URL}?status=${status}" || echo 000)

echo "cron check-in (${status}) responded ${code}"

case "${code}" in
  2??) ;;
  *) echo "::warning::Sentry cron check-in for '${status}' failed with HTTP ${code}. The backup itself is unaffected, but the monitor will report this run as missed." ;;
esac
