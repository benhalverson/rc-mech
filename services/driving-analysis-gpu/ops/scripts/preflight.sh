#!/usr/bin/env bash
set -euo pipefail

config_root=${GPU_OPS_CONFIG_ROOT:-/etc/chassis-notes-gpu}
state_root=${GPU_STATE_ROOT:-/var/lib/chassis-notes-gpu}
model_path=${GPU_MODEL_PATH:-/opt/chassis-notes-gpu/models/sam3.1.pt}
profile_path=${GPU_PROFILE_PATH:-"$config_root/profile.json"}

fail() { printf 'GPU preflight failed: %s\n' "$1" >&2; exit 1; }
command -v docker >/dev/null || fail 'docker is unavailable'
command -v nvidia-container-cli >/dev/null || fail 'NVIDIA Container Toolkit is unavailable'
docker info >/dev/null 2>&1 || fail 'Docker daemon is unavailable'
nvidia-container-cli info >/dev/null 2>&1 || fail 'NVIDIA runtime cannot see a GPU'
[[ -f "$profile_path" && -r "$profile_path" ]] || fail 'profile is missing or unreadable'
[[ -f "$model_path" && -r "$model_path" ]] || fail 'model checkpoint is missing or unreadable'
[[ -d "$state_root" ]] || fail 'encrypted state mount is missing'
state_source=$(findmnt --target "$state_root" --output SOURCE --noheadings) || fail 'state mount is unavailable'
lsblk --inverse --noheadings --output TYPE "$state_source" | grep -Eq '^crypt$' || fail 'state is not on an encrypted filesystem'
[[ "$(stat -c '%u:%g' "$state_root")" == '10001:10001' ]] || fail 'state ownership must be 10001:10001'
[[ "$(stat -c '%a' "$state_root")" == '700' ]] || fail 'state mode must be 0700'
[[ "$(stat -c '%u:%g' "$profile_path")" == '0:10001' ]] || fail 'profile must be root-owned by group 10001'
[[ "$(stat -c '%a' "$profile_path")" == '640' ]] || fail 'profile mode must be 0640'
profile_model_digest=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["model"]["digest"])' "$profile_path") || fail 'profile model digest is invalid'
model_digest=$(sha256sum "$model_path" | cut -d ' ' -f 1)
[[ "$profile_model_digest" == "$model_digest" ]] || fail 'model checkpoint does not match profile digest'
unit=/etc/systemd/system/chassis-notes-gpu.service
grep -Eq -- '--network host' "$unit" || fail 'worker network mode changed'
grep -Eq -- '--read-only' "$unit" || fail 'worker root is writable'
docker image inspect chassis-notes-driving-analysis-gpu:current --format '{{json .Config.Cmd}}' | grep -Eq '127\\.0\\.0\\.1.*8080' || fail 'worker is not loopback-only'
for flag in '--gpus all' '--cap-drop ALL' '--security-opt no-new-privileges:true' '--pids-limit 512' '--memory 32g' '--memory-swap 32g' '--user 10001:10001' '--tmpfs /tmp:rw,noexec,nosuid,nodev,size=512m'; do
  grep -Fq -- "$flag" "$unit" || fail "worker security flag is missing: $flag"
done
for mount in 'dst=/var/lib/chassis-notes-gpu' 'dst=/etc/chassis-notes-gpu/profile.json,readonly' 'dst=/models/sam3.1.pt,readonly'; do
  grep -Fq -- "$mount" "$unit" || fail "worker mount is missing: $mount"
done
runtime_digest=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["runtimeImageDigest"])' "$profile_path") || fail 'profile runtime digest is invalid'
image_digest=$(docker image inspect chassis-notes-driving-analysis-gpu:current --format '{{.Id}}' | sed 's/^sha256://') || fail 'worker image metadata is unavailable'
[[ "$runtime_digest" == "$image_digest" ]] || fail 'worker image does not match profile runtime digest'
docker image inspect chassis-notes-driving-analysis-gpu:current >/dev/null || fail 'worker image is missing'
printf 'GPU preflight passed\n'
