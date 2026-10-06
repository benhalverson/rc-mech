#!/usr/bin/env bash
set -euo pipefail

# This image changes rules inside local proxy containers, never the host.
if [[ -z "${MINIFLARE_CONTAINER_EGRESS_IMAGE:-}" ]]; then
	docker build --pull=false --tag rc-mech-local-container-proxy:local containers/local-proxy
	export MINIFLARE_CONTAINER_EGRESS_IMAGE=rc-mech-local-container-proxy:local
fi

exec pnpm exec wrangler dev --env local "$@"
