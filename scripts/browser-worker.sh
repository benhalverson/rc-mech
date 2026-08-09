#!/usr/bin/env bash
set -euo pipefail
exec node --import tsx scripts/browser-worker.ts
