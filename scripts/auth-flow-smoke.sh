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
    kill -TERM "$worker_pid" 2>/dev/null || true
    kill -TERM -- "-$worker_pid" 2>/dev/null || true
    pkill -TERM -f "wrangler dev --env local --port ${port} " 2>/dev/null || true
    pkill -TERM -f "workerd serve.*socket-addr=entry=.*:${port}" 2>/dev/null || true
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

archived_write_status="$(curl -sS -o /dev/null -b "$cookie_file" -w '%{http_code}' -X POST "$base/api/v1/cars/${car_id}/drives" \
  -H 'Content-Type: application/json' --data '{"startedAt":"2026-08-03T00:00:00.000Z"}')"
[[ "$archived_write_status" == "409" ]]

restore_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' -X POST "$base/api/v1/cars/${car_id}/restore")"
[[ "$restore_status" == "200" ]]
jq -e '.car.archivedAt == null' "$response_file" >/dev/null

active_after_restore_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' "$base/api/v1/cars")"
[[ "$active_after_restore_status" == "200" ]]
jq -e --arg id "$car_id" '.cars[] | select(.id == $id)' "$response_file" >/dev/null

timezone_update_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' -X PATCH "$base/api/v1/preferences/timezone" \
  -H 'Content-Type: application/json' --data '{"timezone":"America/Los_Angeles"}')"
[[ "$timezone_update_status" == "200" ]]
jq -e '.timezone == "America/Los_Angeles"' "$response_file" >/dev/null
timezone_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' "$base/api/v1/preferences/timezone")"
[[ "$timezone_status" == "200" ]]
jq -e '.timezone == "America/Los_Angeles"' "$response_file" >/dev/null
invalid_timezone_status="$(curl -sS -o /dev/null -b "$cookie_file" -w '%{http_code}' -X PATCH "$base/api/v1/preferences/timezone" \
  -H 'Content-Type: application/json' --data '{"timezone":"not/a-timezone"}')"
[[ "$invalid_timezone_status" == "400" ]]
abbreviated_timezone_status="$(curl -sS -o /dev/null -b "$cookie_file" -w '%{http_code}' -X PATCH "$base/api/v1/preferences/timezone" \
  -H 'Content-Type: application/json' --data '{"timezone":"PST"}')"
[[ "$abbreviated_timezone_status" == "400" ]]

drive_create_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' -X POST "$base/api/v1/cars/${car_id}/drives" \
  -H 'Content-Type: application/json' --data '{"startedAt":"2026-08-03T07:30:05.000Z","notes":"morning test session"}')"
[[ "$drive_create_status" == "201" ]]
drive_id="$(jq -r '.driveSession.id' "$response_file")"
[[ -n "$drive_id" && "$drive_id" != "null" ]]
jq -e '.driveSession.startedAt == "2026-08-03T07:30:05.000Z" and .driveSession.localDate == "2026-08-03" and .driveSession.localTime == "00:30:05" and .driveSession.timezone == "America/Los_Angeles" and .driveSession.deletedAt == null' "$response_file" >/dev/null
drive_update_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' -X PATCH "$base/api/v1/cars/${car_id}/drives/${drive_id}" \
  -H 'Content-Type: application/json' --data '{"notes":"updated test session"}')"
[[ "$drive_update_status" == "200" ]]
jq -e '.driveSession.notes == "updated test session"' "$response_file" >/dev/null
drive_count_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' "$base/api/v1/cars/${car_id}/drives/count")"
[[ "$drive_count_status" == "200" ]]
jq -e '.count == 1' "$response_file" >/dev/null
drive_delete_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' -X DELETE "$base/api/v1/cars/${car_id}/drives/${drive_id}")"
[[ "$drive_delete_status" == "200" ]]
jq -e '.driveSession.deletedAt != null' "$response_file" >/dev/null
drive_history_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' "$base/api/v1/cars/${car_id}/drives?history=true")"
[[ "$drive_history_status" == "200" ]]
jq -e --arg id "$drive_id" '.count == 0 and ([.driveSessions[] | select(.id == $id and .deletedAt != null)] | length) == 1' "$response_file" >/dev/null
drive_deleted_update_status="$(curl -sS -o /dev/null -b "$cookie_file" -w '%{http_code}' -X PATCH "$base/api/v1/cars/${car_id}/drives/${drive_id}" \
  -H 'Content-Type: application/json' --data '{"notes":"must stay immutable"}')"
[[ "$drive_deleted_update_status" == "409" ]]

component_create_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' "$base/api/v1/cars/${car_id}/components" \
  -H 'Content-Type: application/json' \
  --data '{"slot":"motor","name":"Competition motor","manufacturer":"RC Mech","model":"M-1","serialNumber":"MOTOR-001","notes":"first installation"}')"
[[ "$component_create_status" == "201" ]]
component_id="$(jq -r '.component.id' "$response_file")"
[[ -n "$component_id" && "$component_id" != "null" ]]
jq -e '.component.slotType == "standard" and .component.manufacturer == "RC Mech" and .component.removedAt == null' "$response_file" >/dev/null

custom_component_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' "$base/api/v1/cars/${car_id}/components" \
  -H 'Content-Type: application/json' \
  --data '{"slot":"front sway bar","name":"Sway bar","slotType":"custom"}')"
[[ "$custom_component_status" == "201" ]]
custom_component_id="$(jq -r '.component.id' "$response_file")"
jq -e '.component.slotType == "custom"' "$response_file" >/dev/null

custom_reinstall_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' "$base/api/v1/cars/${car_id}/components" \
  -H 'Content-Type: application/json' \
  --data '{"slot":"front sway bar","name":"Replacement sway bar","slotType":"custom"}')"
[[ "$custom_reinstall_status" == "201" ]]
custom_replacement_id="$(jq -r '.component.id' "$response_file")"
[[ "$custom_replacement_id" != "$custom_component_id" ]]

custom_history_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' \
  "$base/api/v1/cars/${car_id}/components?history=true")"
[[ "$custom_history_status" == "200" ]]
jq -e --arg old "$custom_component_id" --arg current "$custom_replacement_id" \
  '[.components[] | select(.id == $old or .id == $current)] | length == 2 and (map(select(.id == $old and .removedAt != null)) | length == 1) and (map(select(.id == $current and .removedAt == null)) | length == 1)' \
  "$response_file" >/dev/null

component_update_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' -b "$cookie_file" -X PATCH \
  "$base/api/v1/cars/${car_id}/components/${component_id}" -H 'Content-Type: application/json' \
  --data '{"notes":"updated installation"}')"
[[ "$component_update_status" == "200" ]]
grep -q 'updated installation' "$response_file"

component_replace_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' -X POST \
  "$base/api/v1/cars/${car_id}/components/${component_id}/replace" -H 'Content-Type: application/json' \
  --data '{"slot":"motor","name":"Replacement motor","manufacturer":"RC Mech","model":"M-2","serialNumber":"MOTOR-002"}')"
[[ "$component_replace_status" == "201" ]]
replacement_id="$(jq -r '.component.id' "$response_file")"
[[ "$replacement_id" != "$component_id" ]]
jq -e '.previous.removedAt != null and .component.slot == "motor" and .component.removedAt == null' "$response_file" >/dev/null

historical_update_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' -X PATCH \
  "$base/api/v1/cars/${car_id}/components/${component_id}" -H 'Content-Type: application/json' \
  --data '{"notes":"history must not change"}')"
[[ "$historical_update_status" == "409" ]]

component_history_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' \
  "$base/api/v1/cars/${car_id}/components?history=true")"
[[ "$component_history_status" == "200" ]]
jq -e --arg old "$component_id" --arg current "$replacement_id" \
  '[.components[] | select(.id == $old or .id == $current)] | length == 2 and (map(select(.id == $old and .removedAt != null)) | length == 1) and (map(select(.id == $current and .removedAt == null)) | length == 1)' \
  "$response_file" >/dev/null

current_motor_count="$(curl -fsS -b "$cookie_file" "$base/api/v1/cars/${car_id}/components" | jq '[.components[] | select(.slot == "motor" and .removedAt == null)] | length')"
[[ "$current_motor_count" == "1" ]]

plan_create_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' -X POST "$base/api/v1/maintenance-plans" \
  -H 'Content-Type: application/json' --data "{\"carId\":\"${car_id}\",\"componentId\":\"${replacement_id}\",\"name\":\"Motor service\",\"intervalUnit\":\"weeks\",\"intervalValue\":2,\"intervalSessions\":3,\"baselineAt\":\"2026-08-01T00:00:00.000Z\",\"baselineSessionCount\":0}")"
[[ "$plan_create_status" == "201" ]]
plan_id="$(jq -r '.maintenancePlan.id' "$response_file")"
[[ -n "$plan_id" && "$plan_id" != "null" ]]
jq -e '.maintenancePlan.intervalUnit == "weeks" and .maintenancePlan.intervalValue == 2 and .maintenancePlan.status == "active"' "$response_file" >/dev/null
plans_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' "$base/api/v1/cars/${car_id}/maintenance-plans")"
[[ "$plans_status" == "200" ]]
jq -e --arg id "$plan_id" '.maintenancePlans[] | select(.id == $id)' "$response_file" >/dev/null
cockpit_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' "$base/api/v1/maintenance-cockpit")"
[[ "$cockpit_status" == "200" ]]
jq -e --arg id "$plan_id" '([.upcoming[], .due[], .overdue[]] | map(select(.id == $id)) | length) == 1' "$response_file" >/dev/null
plan_pause_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' -X POST "$base/api/v1/maintenance-plans/${plan_id}/pause")"
[[ "$plan_pause_status" == "200" ]]
jq -e '.maintenancePlan.status == "paused" and .maintenancePlan.pauseReason == "manual"' "$response_file" >/dev/null
plan_resume_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' -X POST "$base/api/v1/maintenance-plans/${plan_id}/resume")"
[[ "$plan_resume_status" == "200" ]] || { cat "$response_file" >&2; false; }
completion_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' -X POST "$base/api/v1/maintenance-plans/${plan_id}/complete" \
  -H 'Content-Type: application/json' --data '{"performedAt":"2026-08-03T12:00:00.000Z","description":"Smoke service"}')"
[[ "$completion_status" == "201" ]]
record_id="$(jq -r '.serviceRecord.id' "$response_file")"
jq -e '.maintenancePlan.baselineAt == "2026-08-03T12:00:00.000Z" and .maintenancePlan.baselineSessionCount == 0' "$response_file" >/dev/null
completion_delete_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' -X DELETE "$base/api/v1/service-records/${record_id}")"
[[ "$completion_delete_status" == "200" ]]
jq -e '.serviceRecord.deletedAt != null' "$response_file" >/dev/null

archive_again_status="$(curl -sS -o /dev/null -b "$cookie_file" -w '%{http_code}' -X POST "$base/api/v1/cars/${car_id}/archive")"
[[ "$archive_again_status" == "200" ]]
archived_plans_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' "$base/api/v1/cars/${car_id}/maintenance-plans")"
[[ "$archived_plans_status" == "200" ]]
jq -e --arg id "$plan_id" '.maintenancePlans[] | select(.id == $id and .status == "paused" and .pauseReason == "car")' "$response_file" >/dev/null
archived_drive_history_status="$(curl -sS -o "$response_file" -b "$cookie_file" -w '%{http_code}' "$base/api/v1/cars/${car_id}/drives?history=true")"
[[ "$archived_drive_history_status" == "200" ]]
jq -e --arg id "$drive_id" '[.driveSessions[] | select(.id == $id)] | length == 1' "$response_file" >/dev/null
archived_drive_create_status="$(curl -sS -o /dev/null -b "$cookie_file" -w '%{http_code}' -X POST "$base/api/v1/cars/${car_id}/drives" \
  -H 'Content-Type: application/json' --data '{"startedAt":"2026-08-03T08:00:00.000Z"}')"
[[ "$archived_drive_create_status" == "409" ]]
archived_drive_update_status="$(curl -sS -o /dev/null -b "$cookie_file" -w '%{http_code}' -X PATCH "$base/api/v1/cars/${car_id}/drives/${drive_id}" \
  -H 'Content-Type: application/json' --data '{"notes":"archived history is read-only"}')"
[[ "$archived_drive_update_status" == "409" ]]
archived_drive_delete_status="$(curl -sS -o /dev/null -b "$cookie_file" -w '%{http_code}' -X DELETE "$base/api/v1/cars/${car_id}/drives/${drive_id}")"
[[ "$archived_drive_delete_status" == "409" ]]
archived_component_write_status="$(curl -sS -o /dev/null -b "$cookie_file" -w '%{http_code}' -X POST \
  "$base/api/v1/cars/${car_id}/components" -H 'Content-Type: application/json' --data '{"slot":"battery","name":"Battery"}')"
[[ "$archived_component_write_status" == "409" ]]
archived_component_update_status="$(curl -sS -o /dev/null -b "$cookie_file" -w '%{http_code}' -X PATCH \
  "$base/api/v1/cars/${car_id}/components/${replacement_id}" -H 'Content-Type: application/json' --data '{"name":"No edit"}')"
[[ "$archived_component_update_status" == "409" ]]
archived_component_replace_status="$(curl -sS -o /dev/null -b "$cookie_file" -w '%{http_code}' -X POST \
  "$base/api/v1/cars/${car_id}/components/${replacement_id}/replace" -H 'Content-Type: application/json' --data '{"slot":"motor","name":"No replacement"}')"
[[ "$archived_component_replace_status" == "409" ]]
curl -fsS -b "$cookie_file" -X POST "$base/api/v1/cars/${car_id}/restore" >/dev/null

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
other_component_list_status="$(curl -sS -o /dev/null -H "Cookie: ${other_cookie}" -w '%{http_code}' "$base/api/v1/cars/${car_id}/components")"
[[ "$other_component_list_status" == "404" ]]
other_component_detail_status="$(curl -sS -o /dev/null -H "Cookie: ${other_cookie}" -w '%{http_code}' "$base/api/v1/cars/${car_id}/components/${replacement_id}")"
[[ "$other_component_detail_status" == "404" ]]
other_component_update_status="$(curl -sS -o /dev/null -H "Cookie: ${other_cookie}" -w '%{http_code}' -X PATCH \
  "$base/api/v1/cars/${car_id}/components/${replacement_id}" -H 'Content-Type: application/json' --data '{"name":"should not change"}')"
[[ "$other_component_update_status" == "404" ]]
other_component_replace_status="$(curl -sS -o /dev/null -H "Cookie: ${other_cookie}" -w '%{http_code}' -X POST \
  "$base/api/v1/cars/${car_id}/components/${replacement_id}/replace" -H 'Content-Type: application/json' --data '{"slot":"motor","name":"should not replace"}')"
[[ "$other_component_replace_status" == "404" ]]
other_drive_list_status="$(curl -sS -o /dev/null -H "Cookie: ${other_cookie}" -w '%{http_code}' "$base/api/v1/cars/${car_id}/drives")"
[[ "$other_drive_list_status" == "404" ]]
other_drive_detail_status="$(curl -sS -o /dev/null -H "Cookie: ${other_cookie}" -w '%{http_code}' "$base/api/v1/cars/${car_id}/drives/${drive_id}")"
[[ "$other_drive_detail_status" == "404" ]]
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
