#!/usr/bin/env bash
set -euo pipefail

# Validate the deployable Worker without changing Cloudflare state. Set
# RC_MECH_DEPLOYED_URL to additionally probe a deployed, same-origin Worker.
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

test -f wrangler.jsonc
test -f public/.gitkeep
grep -q '"assets": { "directory": "./public", "binding": "ASSETS" }' wrangler.jsonc
grep -q '"send_email": \[{ "name": "EMAIL" }\]' wrangler.jsonc
grep -q '"binding": "DB"' wrangler.jsonc
grep -q '"binding": "PHOTOS"' wrangler.jsonc

if [[ "${RC_MECH_REQUIRE_REMOTE_CONFIG:-0}" == "1" ]]; then
	if grep -q '00000000-0000-0000-0000-000000000000' wrangler.jsonc; then
		echo 'production D1 database_id is still the placeholder; replace it before deployment' >&2
		exit 1
	fi
fi

pnpm exec wrangler deploy --dry-run --env production

if [[ -n "${RC_MECH_DEPLOYED_URL:-}" ]]; then
	base="${RC_MECH_DEPLOYED_URL%/}"
	test "$(curl -fsS -o /dev/null -w '%{http_code}' "$base/api/v1/health")" = 200
	test "$(curl -fsS -o /dev/null -w '%{http_code}' "$base/api/docs")" = 200
	test "$(curl -fsS -o /dev/null -w '%{http_code}' "$base/api/openapi.json")" = 200
	test "$(curl -sS -o /dev/null -w '%{http_code}' "$base/api/v1/cars")" = 401
	test "$(curl -sS -o /dev/null -w '%{http_code}' "$base/api/v1/photos/not-authenticated")" = 401
	test "$(curl -sS -o /dev/null -w '%{http_code}' "$base/api/not-a-route")" = 404
	printf 'deployed public/private-boundary smoke passed for %s\n' "$base"
else
	printf 'deploy dry run passed; set RC_MECH_DEPLOYED_URL for deployed smoke\n'
fi
