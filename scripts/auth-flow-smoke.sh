#!/usr/bin/env bash
set -euo pipefail

port="${RC_MECH_TEST_PORT:-8791}"
base="http://127.0.0.1:${port}"
token="rc-mech-test-token-$$"
log_file="$(mktemp)"
cookie_file="$(mktemp)"
response_file="$(mktemp)"
headers_file="$(mktemp)"

cleanup() {
  if [[ -n "${worker_pid:-}" ]]; then
    kill -TERM -- "-$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
  rm -f "$log_file" "$cookie_file" "$response_file" "$headers_file"
}
trap cleanup EXIT

if curl -fsS "$base/api/v1/health" >/dev/null 2>&1; then
  echo "port ${port} is already in use" >&2
  exit 1
fi

setsid pnpm exec wrangler dev --env local --port "$port" --var "APP_URL:${base}" --var "OWNER_EMAIL:owner@example.com" --var "MAGIC_LINK_TEST_TOKEN:${token}" >"$log_file" 2>&1 &
worker_pid=$!

for _ in {1..40}; do
  if grep -q "Ready on http://localhost:${port}" "$log_file" && curl -fsS "$base/api/v1/health" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
grep -q "Ready on http://localhost:${port}" "$log_file"
curl -fsS "$base/api/v1/health" >/dev/null

request_status="$(curl -sS -o "$response_file" -w '%{http_code}' "$base/api/auth/sign-in/magic-link" \
  -H 'Content-Type: application/json' \
  --data '{"email":"owner@example.com","callbackURL":"/"}')"
[[ "$request_status" == "200" ]]
grep -q '"status":true' "$response_file"

verify_status="$(curl -sS -o /dev/null -D "$headers_file" -c "$cookie_file" -w '%{http_code}' \
  "$base/api/auth/magic-link/verify?token=${token}&callbackURL=%2F")"
[[ "$verify_status" == "302" ]]
grep -q '^Location: ' "$headers_file"

session_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' "$base/api/auth/get-session")"
[[ "$session_status" == "200" ]]
grep -q '"session":{' "$response_file"

cars_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' "$base/api/v1/cars")"
[[ "$cars_status" == "200" ]]

reuse_status="$(curl -sS -o /dev/null -D "$headers_file" -w '%{http_code}' \
  "$base/api/auth/magic-link/verify?token=${token}&callbackURL=%2F")"
[[ "$reuse_status" == "302" ]]
grep -q 'error=INVALID_TOKEN' "$headers_file"

echo "auth flow smoke test passed"
