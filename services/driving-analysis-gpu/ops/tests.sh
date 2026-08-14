#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash -n "$root/install.sh" "$root/scripts/preflight.sh" "$root/scripts/verify.sh"
grep -q '127.0.0.1:8080' "$root/config/chassis-notes-gpu.yml.example"
grep -q 'service: http_status:404' "$root/config/chassis-notes-gpu.yml.example"
grep -q -- '--cap-drop ALL' "$root/systemd/chassis-notes-gpu.service"
grep -q -- '--security-opt no-new-privileges:true' "$root/systemd/chassis-notes-gpu.service"
grep -q -- '--mount type=bind,src=/opt/chassis-notes-gpu/models/sam3.1.pt,dst=/models/sam3.1.pt,readonly' "$root/systemd/chassis-notes-gpu.service"
grep -q -- '--network host' "$root/systemd/chassis-notes-gpu.service"
grep -q -- '--read-only' "$root/systemd/chassis-notes-gpu.service"
grep -q -- '--host", "127.0.0.1"' "$root/../Dockerfile"
if grep -Eiq '^[A-Z_]*(ACCESS|R2|D1|WORKFLOW|TOKEN|SECRET|CREDENTIAL)' "$root/config/worker.env.example"; then
  printf 'worker.env.example contains forbidden credential material\n' >&2
  exit 1
fi
printf 'GPU ops asset checks passed\n'
