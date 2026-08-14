#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -u)" == 0 ]] || { printf 'Run as root\n' >&2; exit 1; }
root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
install -d -m 0755 /etc/chassis-notes-gpu /etc/cloudflared /opt/chassis-notes-gpu/models
install -m 0750 "$root/scripts/preflight.sh" /etc/chassis-notes-gpu/preflight.sh
install -m 0750 "$root/scripts/verify.sh" /etc/chassis-notes-gpu/verify.sh
install -m 0644 "$root/systemd/chassis-notes-gpu.service" /etc/systemd/system/chassis-notes-gpu.service
install -m 0644 "$root/systemd/cloudflared.service" /etc/systemd/system/cloudflared.service
install -o root -g root -m 0600 /dev/null /etc/chassis-notes-gpu/worker.env
printf 'Install skeleton created. Provision profile, model, encrypted state, and Tunnel credentials out of band.\n'
