#!/usr/bin/env bash
set -euo pipefail

# Validate the deployable Worker without changing Cloudflare state. Set
# RC_MECH_DEPLOYED_URL to additionally probe a deployed, same-origin Worker.
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"
response_file="$(mktemp)"
trap 'rm -f "$response_file"' EXIT

test -f wrangler.jsonc
test -f public/.gitkeep
pnpm exec wrangler deploy --dry-run

if [[ "${RC_MECH_REQUIRE_REMOTE_CONFIG:-0}" == "1" ]]; then
	: "${RC_MECH_DEPLOYED_URL:?RC_MECH_DEPLOYED_URL is required for release acceptance}"
	: "${RC_MECH_OWNER_COOKIE:?RC_MECH_OWNER_COOKIE is required for release acceptance}"
	: "${RC_MECH_OWNER_CAR_ID:?RC_MECH_OWNER_CAR_ID is required for release acceptance}"
	: "${RC_MECH_OWNER_PHOTO_ID:?RC_MECH_OWNER_PHOTO_ID is required for release acceptance}"
	: "${RC_MECH_OTHER_OWNER_COOKIE:?RC_MECH_OTHER_OWNER_COOKIE is required for release acceptance}"
	: "${RC_MECH_R2_PUBLIC_ACCESS_VALIDATED:?Set RC_MECH_R2_PUBLIC_ACCESS_VALIDATED=1 after verifying r2.dev and custom-domain access are disabled}"
	test "$RC_MECH_R2_PUBLIC_ACCESS_VALIDATED" = 1
	if ! pnpm exec wrangler secret list --format json | jq -e 'map(.name) | (["APP_URL", "BETTER_AUTH_SECRET", "OWNER_EMAIL", "EMAIL_FROM", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "GPU_ACCESS_CLIENT_ID", "GPU_ACCESS_CLIENT_SECRET"] - .) == []' >/dev/null; then
		echo 'production secrets are incomplete; configure application, email, R2 signing, and GPU Access secrets' >&2
		exit 1
	fi
	if ! pnpm exec wrangler r2 bucket list | grep -q '^name:[[:space:]]*rc-mech-photos$'; then
		echo 'production R2 bucket rc-mech-photos was not found' >&2
		exit 1
	fi
	if ! pnpm exec wrangler r2 bucket list | grep -q '^name:[[:space:]]*rc-mech-analysis-media$'; then
		echo 'production R2 bucket rc-mech-analysis-media was not found' >&2
		exit 1
	fi
	migration_output="$(pnpm exec wrangler d1 migrations list DB --remote 2>&1)" || {
		echo "$migration_output" >&2
		exit 1
	}
	if ! grep -q 'No migrations to apply' <<<"$migration_output"; then
		echo 'production D1 migration status is not clean; apply all migrations before release' >&2
		exit 1
	fi
	custom_domains="$(pnpm exec wrangler r2 bucket domain list rc-mech-photos 2>&1)" || {
		echo "$custom_domains" >&2
		exit 1
	}
	if ! grep -qi 'no custom domains' <<<"$custom_domains"; then
		echo 'production R2 bucket has a custom domain; remove public exposure before release' >&2
		exit 1
	fi
	analysis_custom_domains="$(pnpm exec wrangler r2 bucket domain list rc-mech-analysis-media 2>&1)" || {
		echo "$analysis_custom_domains" >&2
		exit 1
	}
	if ! grep -qi 'no custom domains' <<<"$analysis_custom_domains"; then
		echo 'production analysis-media R2 bucket has a custom domain; remove public exposure before release' >&2
		exit 1
	fi
fi

if [[ -n "${RC_MECH_DEPLOYED_URL:-}" ]]; then
	base="${RC_MECH_DEPLOYED_URL%/}"
	test "$(curl -fsS -o /dev/null -w '%{http_code}' "$base/api/v1/health")" = 200
	test "$(curl -fsS -o /dev/null -w '%{http_code}' "$base/api/docs")" = 200
	test "$(curl -fsS -o /dev/null -w '%{http_code}' "$base/api/openapi.json")" = 200
	test "$(curl -sS -o /dev/null -w '%{http_code}' "$base/api/v1/cars")" = 401
	test "$(curl -sS -o /dev/null -w '%{http_code}' "$base/api/v1/photos/not-authenticated")" = 401
	test "$(curl -sS -o /dev/null -w '%{http_code}' "$base/api/not-a-route")" = 404
	if [[ "${RC_MECH_REQUIRE_REMOTE_CONFIG:-0}" == "1" ]]; then
		host="$(node -e 'console.log(new URL(process.argv[1]).hostname)' "$base")"
		rp_status="$(curl -sS -o "$response_file" -b "$RC_MECH_OWNER_COOKIE" -w '%{http_code}' "$base/api/auth/passkey/generate-register-options?name=release-check")"
		test "$rp_status" = 200
		test "$(jq -r '.rp.id' "$response_file")" = "$host"
		test "$(curl -sS -o /dev/null -b "$RC_MECH_OWNER_COOKIE" -w '%{http_code}' "$base/api/v1/cars/$RC_MECH_OWNER_CAR_ID")" = 200
		test "$(curl -sS -o /dev/null -b "$RC_MECH_OWNER_COOKIE" -w '%{http_code}' "$base/api/v1/cars/$RC_MECH_OWNER_CAR_ID/photos")" = 200
		test "$(curl -sS -o /dev/null -b "$RC_MECH_OWNER_COOKIE" -w '%{http_code}' "$base/api/v1/photos/$RC_MECH_OWNER_PHOTO_ID")" = 200
		for endpoint in components drives maintenance-plans maintenance-cockpit service-records photos; do
			test "$(curl -sS -o /dev/null -b "$RC_MECH_OWNER_COOKIE" -w '%{http_code}' "$base/api/v1/cars/$RC_MECH_OWNER_CAR_ID/$endpoint")" = 200
		done
		test "$(curl -sS -o /dev/null -H "Cookie: $RC_MECH_OTHER_OWNER_COOKIE" -w '%{http_code}' "$base/api/v1/cars/$RC_MECH_OWNER_CAR_ID")" = 404
		test "$(curl -sS -o /dev/null -H "Cookie: $RC_MECH_OTHER_OWNER_COOKIE" -w '%{http_code}' "$base/api/v1/cars/$RC_MECH_OWNER_CAR_ID/photos")" = 404
		test "$(curl -sS -o /dev/null -H "Cookie: $RC_MECH_OTHER_OWNER_COOKIE" -w '%{http_code}' "$base/api/v1/photos/$RC_MECH_OWNER_PHOTO_ID")" = 404
		for endpoint in components drives maintenance-plans maintenance-cockpit service-records; do
			test "$(curl -sS -o /dev/null -H "Cookie: $RC_MECH_OTHER_OWNER_COOKIE" -w '%{http_code}' "$base/api/v1/cars/$RC_MECH_OWNER_CAR_ID/$endpoint")" = 404
		done
	fi
	printf 'deployed public/private-boundary smoke passed for %s\n' "$base"
else
	printf 'deploy dry run passed; set RC_MECH_DEPLOYED_URL for deployed smoke\n'
fi
