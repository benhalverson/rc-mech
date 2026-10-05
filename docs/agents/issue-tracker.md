# Issue tracker

This repository uses [GitHub Issues](https://github.com/benhalverson/rc-mech/issues)
in `benhalverson/rc-mech`.

Read a specification with `gh issue view <number> --repo benhalverson/rc-mech --json title,body,url`.
Before filing a follow-up bug, search open and closed issues with
`gh issue list --repo benhalverson/rc-mech --state all --search '<keywords>'`.
Include severity, evidence, and acceptance criteria in confirmed review follow-ups.

Issue #295 implements the reliable Tracking waits and retries requirements of
[ADR 0028](../adr/0028-use-cloudflare-controlled-local-gpu-inference.md).
Its implementation review baseline is `b72961569b5a2d48d5ce81255e98ad85f3a74857`.
