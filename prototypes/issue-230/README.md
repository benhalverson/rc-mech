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

## Limitation

Cloudflare's local Container runtime always starts an outbound-interception
sidecar. WSL2 kernel `5.15.167.4-microsoft-standard-WSL2` cannot start that
sidecar because its `xt_socket` iptables extension is unavailable. On that
host, the proof emits a structured `FAIL` verdict before FastAPI starts. Run
the same command on a Linux host with the required netfilter capabilities to
exercise the complete binding path. The throwaway branch also runs that exact
command on an Ubuntu runner so the issue can link durable proof output.

The prototype disables Container internet access. It does not validate the
later Worker-mediated private R2 design or any video-processing behavior.
