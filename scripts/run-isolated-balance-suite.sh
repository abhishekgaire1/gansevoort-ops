#!/usr/bin/env bash
#
# Runs the inventory balance/posting suites against a CLEAN, ISOLATED database
# built from the full migration history -- the only environment in which the
# exact-value balance assertions are deterministic (the shared long-lived DEV
# fixture org accumulates state that makes them flaky; see docs/ERROR_CODES.md
# and prior reports).
#
# It NEVER targets production or the shared DEV project, and never prints secrets.
#
# Required environment variables (point ALL at the disposable/clean project):
#   ISOLATED_SUPABASE_URL             e.g. https://<ref>.supabase.co
#   ISOLATED_SUPABASE_SECRET_KEY      service-role / secret key of the clean project
#   ISOLATED_SUPABASE_PUBLISHABLE_KEY anon/publishable key of the clean project
#   PIN_PEPPER, KIOSK_TOKEN_SECRET, KIOSK_DEVICE_ID_SECRET, KIOSK_ORGANIZATION_ID
#                                     (may be reused from .env.local for tests)
#
# Preconditions the operator must satisfy on the clean project FIRST:
#   supabase link --project-ref <clean-ref> && supabase db push
#   (applies the complete migration history, including 100171/100172)
#
# Usage:
#   ISOLATED_SUPABASE_URL=... ISOLATED_SUPABASE_SECRET_KEY=... \
#   ISOLATED_SUPABASE_PUBLISHABLE_KEY=... bash scripts/run-isolated-balance-suite.sh
set -euo pipefail

# --- Refuse to run without an explicit isolated target ---
: "${ISOLATED_SUPABASE_URL:?Set ISOLATED_SUPABASE_URL to the clean, disposable project}"
: "${ISOLATED_SUPABASE_SECRET_KEY:?Set ISOLATED_SUPABASE_SECRET_KEY}"
: "${ISOLATED_SUPABASE_PUBLISHABLE_KEY:?Set ISOLATED_SUPABASE_PUBLISHABLE_KEY}"

# --- Hard refusal: never the shared DEV project or anything that smells prod ---
FORBIDDEN_REFS=("cstphoxgsuzulqmrfgnh") # shared DEV project ref (known)
for ref in "${FORBIDDEN_REFS[@]}"; do
  if [[ "$ISOLATED_SUPABASE_URL" == *"$ref"* ]]; then
    echo "REFUSED: ISOLATED_SUPABASE_URL points at the shared DEV project ($ref). Use a disposable clean project." >&2
    exit 2
  fi
done
if [[ "$ISOLATED_SUPABASE_URL" == *"prod"* || "$ISOLATED_SUPABASE_URL" == *"production"* ]]; then
  echo "REFUSED: ISOLATED_SUPABASE_URL looks like production." >&2
  exit 2
fi
# Print only the host, never keys.
echo "Target (host only): $(echo "$ISOLATED_SUPABASE_URL" | sed -E 's#https?://([^/]+).*#\1#')"

# --- Run the balance/posting suites against the isolated project ---
# Map the ISOLATED_* vars onto the names the test harness reads. Secrets are
# passed via the environment only (never echoed, never written to disk).
SUPABASE_URL="$ISOLATED_SUPABASE_URL" \
SUPABASE_SECRET_KEY="$ISOLATED_SUPABASE_SECRET_KEY" \
SUPABASE_PUBLISHABLE_KEY="$ISOLATED_SUPABASE_PUBLISHABLE_KEY" \
  npx tsx scripts/test-integration-setup.ts

SUPABASE_URL="$ISOLATED_SUPABASE_URL" \
SUPABASE_SECRET_KEY="$ISOLATED_SUPABASE_SECRET_KEY" \
SUPABASE_PUBLISHABLE_KEY="$ISOLATED_SUPABASE_PUBLISHABLE_KEY" \
  npx vitest run --testTimeout=60000 \
    tests/inventoryPosting.rpc.test.ts \
    tests/inventoryBalances.rpc.test.ts \
    tests/purchaseUsageUnits.rpc.test.ts \
    tests/deliveryLineagePostingGuard.rpc.test.ts

echo "Isolated balance-suite run complete."
