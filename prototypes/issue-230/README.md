# Issue 230 Worker-to-FastAPI Container prototype

This throwaway prototype proves the authenticated Hono Worker-to-Python
Container call path. It does not define production Driving-analysis module
boundaries and must not be merged.

## Prerequisites

- Node 24 and pnpm
- Docker-compatible CLI and running engine
- A Linux kernel with the `TPROXY` and `xt_socket` netfilter capabilities used
  by Cloudflare's local Container sidecar

## Run the proof

```console
pnpm prototype:230:prove
```

The typed Node/TypeScript command creates temporary local D1 state for the existing Better Auth
session, starts Wrangler, builds and launches the named Cloudflare Container,
calls the FastAPI service through the Container binding, records cold and warm
behavior, and then removes its temporary state.

For interactive development, run `pnpm prototype:230:dev`. Run the Python and
TypeScript contract tests with `pnpm prototype:230:test`, and validate the same
Container-enabled configuration without deployment using
`pnpm prototype:230:dry-run`.

## Temporary WSL2 workaround for workerd issue #6793

Cloudflare [workerd issue #6793](https://github.com/cloudflare/workerd/issues/6793)
tracks a local Container sidecar rule-ordering bug on newer Linux kernels. The
sidecar can install its socket `DIVERT` rule before a Docker bridge bypass,
intercept its own control-plane traffic, and then time out during readiness.
[Workerd PR #6794](https://github.com/cloudflare/workerd/pull/6794) proposes the
upstream fix.

The proof is deliberately platform-neutral and never changes iptables. On an
affected WSL2 host, start the explicitly named TypeScript workaround first and
then run the proof in a second terminal while the workaround watches for every
sidecar Wrangler creates or replaces:

```console
# Terminal 1
pnpm prototype:230:wsl-workaround

# Terminal 2
pnpm prototype:230:prove
```

Leave terminal 1 running until terminal 2 reports its verdict, then stop the
workaround with Ctrl+C. A patched-sidecar message is progress, not completion;
the watcher remains active because Wrangler can replace that sidecar during
startup or recovery.

The workaround discovers the matching Cloudflare proxy sidecar and Docker's
actual bridge CIDR. Inside that sidecar only, it idempotently ensures this is
the first `mangle/PREROUTING` rule:

```text
-A PREROUTING -s <docker-bridge-cidr> -d <docker-bridge-cidr> -j RETURN
```

It does not delete Cloudflare's `-m socket -j DIVERT` rule. The change lasts
only as long as that local sidecar. Remove the workaround after a released
Wrangler/workerd build is verified to include PR #6794. If the unmodified proof
sees the exact WSL2 timeout signature, its structured `FAIL` output identifies
workerd issue #6793 and prints the two-terminal next step.

The prototype disables Container internet access. It does not validate the
later Worker-mediated private R2 design or any video-processing behavior.
