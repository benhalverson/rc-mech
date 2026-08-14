#!/usr/bin/env bash
set -euo pipefail

unit_root=${GPU_UNIT_ROOT:-/etc/systemd/system}
config=${GPU_TUNNEL_CONFIG:-/etc/cloudflared/chassis-notes-gpu.yml}
fail() { printf 'GPU verification failed: %s\n' "$1" >&2; exit 1; }
systemd-analyze verify "$unit_root/chassis-notes-gpu.service" "$unit_root/cloudflared.service"
[[ -r "$config" ]] || fail 'Tunnel config is missing'
grep -Eq 'service: http://127\.0\.0\.1:8080$' "$config" || fail 'Tunnel is not loopback-only'
grep -Eq 'service: http_status:404$' "$config" || fail 'Tunnel has no default deny ingress'
grep -Eq -- '--network host' "$unit_root/chassis-notes-gpu.service" || fail 'worker network mode changed'
grep -Eq -- '--cap-drop ALL' "$unit_root/chassis-notes-gpu.service" || fail 'worker capabilities are not dropped'
grep -Eq -- '--read-only' "$unit_root/chassis-notes-gpu.service" || fail 'worker root is writable'
grep -Eq -- '--gpus all' "$unit_root/chassis-notes-gpu.service" || fail 'GPU access is not configured'
if grep -Eiq '^[A-Z_]*(ACCESS|R2|D1|WORKFLOW|TOKEN|SECRET|CREDENTIAL)' /etc/chassis-notes-gpu/worker.env; then
  fail 'worker environment contains a forbidden credential or control-plane binding'
fi
printf 'GPU service verification passed\n'
