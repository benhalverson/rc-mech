#!/usr/bin/env bash
set -euo pipefail
state_dir="$(mktemp -d -t rc-mech-browser.XXXXXX)"
pnpm exec wrangler d1 migrations apply DB --local --env local --persist-to "$state_dir" >/dev/null
exec pnpm exec wrangler dev --env local --local --port 8787 --persist-to "$state_dir" \
	--var 'APP_URL:http://127.0.0.1:8787' --var 'OWNER_EMAIL:owner@example.com' \
	--var 'MAGIC_LINK_TEST_TOKEN:local-test-token'
