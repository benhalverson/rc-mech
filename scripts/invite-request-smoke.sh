#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"
port="${RC_MECH_INVITE_PORT:-8791}"
base="http://127.0.0.1:${port}"
state_dir="$(mktemp -d)"
log_file="$(mktemp)"
owner_cookie="$(mktemp)"
user_cookie="$(mktemp)"
response_file="$(mktemp)"
headers_file="$(mktemp)"
worker_pid=""
cleanup() {
	local exit_code=$?
	if [[ -n "$worker_pid" ]]; then
		kill -- -"$worker_pid" 2>/dev/null || kill "$worker_pid" 2>/dev/null || true
		wait "$worker_pid" 2>/dev/null || true
	fi
	if [[ "$exit_code" != 0 ]]; then
		cat "$response_file" >&2 || true
		tail -40 "$log_file" >&2 || true
	fi
	rm -rf "$state_dir" "$log_file" "$owner_cookie" "$user_cookie" "$response_file" "$headers_file"
}
trap cleanup EXIT

pnpm exec wrangler d1 migrations apply DB --local --env local --persist-to "$state_dir" >/dev/null

setsid pnpm exec wrangler dev --env local --local --port "$port" --persist-to "$state_dir" \
	--var "APP_URL:${base}" --var 'OWNER_EMAIL:owner@example.com' \
	--var 'MAGIC_LINK_TEST_TOKEN:local-test-token' >"$log_file" 2>&1 &
worker_pid=$!
for _ in {1..60}; do
	if curl -fsS "$base/api/v1/health" >/dev/null 2>&1; then break; fi
	sleep 0.25
done
curl -fsS "$base/api/v1/health" >/dev/null
seed_output="$(pnpm exec tsx scripts/invite-cli.ts --url "$base" --owner-email owner@example.com --code owner-01)"
printf '%s' "$seed_output" | jq -r '.cookie' >"$owner_cookie"
owner_header="$(cat "$owner_cookie")"

status="$(curl -sS -o "$response_file" -w '%{http_code}' "$base/api/auth/register" \
	-H 'Content-Type: application/json' -H 'CF-Connecting-IP: 198.51.100.10' \
	--data '{"email":" UserA@Example.COM ","inviteCode":" owner-01 ","callbackURL":"/garage"}')"
test "$status" = 200
jq -e '.status == true' "$response_file" >/dev/null

status="$(curl -sS -o "$response_file" -w '%{http_code}' "$base/api/auth/register" \
	-H 'Content-Type: application/json' -H 'CF-Connecting-IP: 198.51.100.11' \
	--data '{"email":"other@example.com","inviteCode":"owner-01"}')"
test "$status" = 200
jq -e '.status == true' "$response_file" >/dev/null

for attempt in {1..8}; do
	curl -sS -o /dev/null "$base/api/auth/register" \
		-H 'Content-Type: application/json' -H 'CF-Connecting-IP: 198.51.100.12' \
		--data '{"email":"unknown@example.com","inviteCode":"owner-01"}'
done
status="$(curl -sS -o "$response_file" -D "$headers_file" -w '%{http_code}' "$base/api/auth/register" \
	-H 'Content-Type: application/json' -H 'CF-Connecting-IP: 198.51.100.12' \
	--data '{"email":"unknown@example.com","inviteCode":"owner-01"}')"
test "$status" = 429
grep -qi '^Retry-After: 60' "$headers_file"
jq -e '.guidance | contains("wait")' "$response_file" >/dev/null

status="$(curl -sS -o "$response_file" -H "Cookie: $owner_header" -w '%{http_code}' "$base/api/v1/invite-codes")"
test "$status" = 200
jq -e '.codes | length == 1 and .[0].status == "reserved" and .[0].reservedEmail == "usera@example.com" and .[0].code == "OWNER-01"' "$response_file" >/dev/null

status="$(curl -sS -o "$response_file" -w '%{http_code}' -c "$user_cookie" \
	"$base/api/auth/magic-link/verify?token=local-test-token&callbackURL=%2Fgarage")"
test "$status" = 302
status="$(curl -sS -o "$response_file" -b "$user_cookie" -w '%{http_code}' "$base/api/v1/cars")"
test "$status" = 200
jq -e '.cars | length == 0' "$response_file" >/dev/null

printf 'invite request-boundary smoke passed\n'
