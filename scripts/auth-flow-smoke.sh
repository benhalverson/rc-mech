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

create_car_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' "$base/api/v1/cars" \
  -H 'Content-Type: application/json' \
  --data '{"name":"Smoke buggy","make":"RC Mech","model":"B-01","scale":"1:10","vehicleType":"buggy","powerType":"electric","notes":"ownership smoke test"}')"
[[ "$create_car_status" == "201" ]]
car_id="$(jq -r '.car.id' "$response_file")"
[[ -n "$car_id" && "$car_id" != "null" ]]
jq -e '.car.ownerId == null and .car.name == "Smoke buggy" and .car.make == "RC Mech" and .car.vehicleType == "buggy" and .car.powerType == "electric" and .car.archivedAt == null' "$response_file" >/dev/null

detail_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' "$base/api/v1/cars/${car_id}")"
[[ "$detail_status" == "200" ]]
jq -e '.car.id == "'"$car_id"'" and .car.archivedAt == null' "$response_file" >/dev/null

archive_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' -X POST "$base/api/v1/cars/${car_id}/archive")"
[[ "$archive_status" == "200" ]]
jq -e '.car.archivedAt != null' "$response_file" >/dev/null

active_after_archive_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' "$base/api/v1/cars")"
[[ "$active_after_archive_status" == "200" ]]
! jq -e --arg id "$car_id" '.cars[] | select(.id == $id)' "$response_file" >/dev/null

archived_list_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' "$base/api/v1/cars?archived=true")"
[[ "$archived_list_status" == "200" ]]
jq -e --arg id "$car_id" '.cars[] | select(.id == $id and .archivedAt != null)' "$response_file" >/dev/null

archived_detail_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' "$base/api/v1/cars/${car_id}")"
[[ "$archived_detail_status" == "200" ]]
jq -e '.car.archivedAt != null' "$response_file" >/dev/null

restore_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' -X POST "$base/api/v1/cars/${car_id}/restore")"
[[ "$restore_status" == "200" ]]
jq -e '.car.archivedAt == null' "$response_file" >/dev/null

active_after_restore_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' "$base/api/v1/cars")"
[[ "$active_after_restore_status" == "200" ]]
jq -e --arg id "$car_id" '.cars[] | select(.id == $id)' "$response_file" >/dev/null

other_owner_id="smoke-owner-${BASHPID}"
other_session_id="smoke-session-${BASHPID}"
other_session_token="smoke-owner-session-${BASHPID}-0123456789abcdef"
now_ms="$(( $(date +%s) * 1000 ))"
expires_ms="$(( now_ms + 3600000 ))"
pnpm exec wrangler d1 execute DB --local --command "INSERT INTO owner (id, name, email, email_verified, created_at, updated_at) VALUES ('${other_owner_id}', 'Other owner', 'other-${BASHPID}@example.com', 1, ${now_ms}, ${now_ms}); INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id) VALUES ('${other_session_id}', ${expires_ms}, '${other_session_token}', ${now_ms}, ${now_ms}, '${other_owner_id}');" >/dev/null
other_session_signature="$(printf %s "$other_session_token" | openssl dgst -sha256 -hmac 'local-development-secret-change-me' -binary | base64 -w 0)"
other_cookie="better-auth.session_token=${other_session_token}.${other_session_signature}"
other_list_status="$(curl -sS -o "$response_file" -H "Cookie: ${other_cookie}" -w '%{http_code}' "$base/api/v1/cars")"
[[ "$other_list_status" == "200" ]]
! jq -e --arg id "$car_id" '.cars[] | select(.id == $id)' "$response_file" >/dev/null
other_detail_status="$(curl -sS -o /dev/null -H "Cookie: ${other_cookie}" -w '%{http_code}' "$base/api/v1/cars/${car_id}")"
[[ "$other_detail_status" == "404" ]]
other_update_status="$(curl -sS -o /dev/null -H "Cookie: ${other_cookie}" -w '%{http_code}' -X PATCH "$base/api/v1/cars/${car_id}" \
  -H 'Content-Type: application/json' --data '{"name":"should not change"}')"
[[ "$other_update_status" == "404" ]]
other_archive_status="$(curl -sS -o /dev/null -H "Cookie: ${other_cookie}" -w '%{http_code}' -X POST "$base/api/v1/cars/${car_id}/archive")"
[[ "$other_archive_status" == "404" ]]

invalid_car_status="$(curl -sS -o /dev/null -b "$cookie_file" -w '%{http_code}' "$base/api/v1/cars" \
  -H 'Content-Type: application/json' --data '{"vehicleType":"missing name"}')"
[[ "$invalid_car_status" == "400" ]]

reuse_status="$(curl -sS -o /dev/null -D "$headers_file" -w '%{http_code}' \
  "$base/api/auth/magic-link/verify?token=${token}&callbackURL=%2F")"
[[ "$reuse_status" == "302" ]]
grep -q 'error=INVALID_TOKEN' "$headers_file"

unauthenticated_register_status="$(curl -sS -o /dev/null -w '%{http_code}' "$base/api/auth/passkey/generate-register-options")"
[[ "$unauthenticated_register_status" == "401" ]]

unauthenticated_list_status="$(curl -sS -o /dev/null -w '%{http_code}' "$base/api/auth/passkey/list-user-passkeys")"
[[ "$unauthenticated_list_status" == "401" ]]

register_options_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' "$base/api/auth/passkey/generate-register-options?name=Smoke%20key")"
[[ "$register_options_status" == "200" ]]
grep -q '"rp":{"name":"RC Mech","id":"127.0.0.1"}' "$response_file"
grep -q '"residentKey":"required"' "$response_file"

authentication_options_status="$(curl -sS -o "$response_file" -w '%{http_code}' "$base/api/auth/passkey/generate-authenticate-options")"
[[ "$authentication_options_status" == "200" ]]
grep -q '"challenge"' "$response_file"
! grep -q '"allowCredentials"' "$response_file"

owner_id="$(pnpm exec wrangler d1 execute DB --local --command "SELECT id FROM owner WHERE email='owner@example.com'" --json | jq -r '.[0].results[0].id')"
passkey_id="smoke-passkey-$$"
pnpm exec wrangler d1 execute DB --local --command "INSERT INTO passkey (id, name, public_key, user_id, credential_id, counter, device_type, backed_up, transports) VALUES ('${passkey_id}', 'Smoke key', 'cHVibGljLWtleQ', '${owner_id}', 'smoke-credential-${passkey_id}', 0, 'singleDevice', 0, '')" >/dev/null

list_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' "$base/api/auth/passkey/list-user-passkeys")"
[[ "$list_status" == "200" ]]
grep -q "${passkey_id}" "$response_file"

rename_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' "$base/api/auth/passkey/update-passkey" \
  -H "Origin: ${base}" -H 'Content-Type: application/json' --data "{\"id\":\"${passkey_id}\",\"name\":\"Garage laptop\"}")"
[[ "$rename_status" == "200" ]]
grep -q '"name":"Garage laptop"' "$response_file"

revoke_status="$(curl -sS -o /dev/null -b "$cookie_file" -w '%{http_code}' "$base/api/auth/passkey/delete-passkey" \
  -H "Origin: ${base}" -H 'Content-Type: application/json' --data "{\"id\":\"${passkey_id}\"}")"
[[ "$revoke_status" == "200" ]]

curl -fsS -o /dev/null -b "$cookie_file" -X POST -H "Origin: ${base}" -H 'Content-Type: application/json' --data '{}' "$base/api/auth/sign-out"
request_recovery_status="$(curl -sS -o /dev/null -w '%{http_code}' "$base/api/auth/sign-in/magic-link" \
  -H 'Content-Type: application/json' --data '{"email":"owner@example.com","callbackURL":"/"}')"
[[ "$request_recovery_status" == "200" ]]
recovery_status="$(curl -sS -o /dev/null -D "$headers_file" -c "$cookie_file" -w '%{http_code}' \
  "$base/api/auth/magic-link/verify?token=${token}&callbackURL=%2F")"
[[ "$recovery_status" == "302" ]]
recovery_session_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' "$base/api/auth/get-session")"
[[ "$recovery_session_status" == "200" ]]
grep -q '"session":{' "$response_file"

echo "auth flow smoke test passed"
