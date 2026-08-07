# Production deployment and browser acceptance

Issue #11 is a release checklist for the single-Worker application. The
Angular build is copied into `public/`; Wrangler serves those files through
the same origin as the authenticated API. Do not deploy a separately hosted
Angular shell or change the browser's relative `/api/...` URLs.

## Production configuration

Create the dedicated production D1 once, then put its returned UUID in the
top-level production Wrangler configuration. Keep the `env.local` D1
placeholder isolated for local simulation. Retain the existing private R2
bucket:

```sh
pnpm exec wrangler d1 create rc-mech
```

The Cloudflare-managed deployment invokes `pnpm deploy` on `main`. That
command builds the Angular assets, runs `pnpm db:migrate:production`, and then
deploys the Worker. The remote D1 migration command consults D1's migration
ledger, so applied migrations are no-ops and pending migrations are applied.
If the migration step fails, the Worker is not deployed.

The production Worker needs these bindings and values:

- `DB`: the production D1 database, with all migrations applied.
- `PHOTOS`: the private `rc-mech-photos` R2 bucket. Do not make it public.
- `EMAIL`: Cloudflare Email Service for magic-link delivery.
- `APP_URL`: the final HTTPS origin; it controls redirects, trusted origins,
  cookies, and the passkey relying-party identity.
- `BETTER_AUTH_SECRET`: a production secret.
- `OWNER_EMAIL`: the normalized owner address allowed to sign in.
- `EMAIL_FROM`: a verified sender address for Email Service.

Set secrets with Wrangler rather than committing them:

```sh
pnpm exec wrangler secret put APP_URL
pnpm exec wrangler secret put BETTER_AUTH_SECRET
pnpm exec wrangler secret put OWNER_EMAIL
pnpm exec wrangler secret put EMAIL_FROM
```

Before deployment, run the clean-checkout checks and build the static shell:

```sh
pnpm install --frozen-lockfile
pnpm cf-typegen
pnpm db:migrate:local
pnpm check
pnpm client:build
pnpm exec wrangler deploy --dry-run
pnpm run deploy
```

The dry-run and local migration commands above do not change production. The
production remote migration is part of `pnpm run deploy`.

Production migrations must remain backward-compatible with the currently
deployed Worker. Use an expand/deploy/contract sequence: add compatible schema
first, deploy code that uses it, and remove old schema only in a later release.

`public/.gitignore` keeps generated Angular bundles untracked while retaining
the directory marker. A successful build should not dirty tracked files.

`pnpm test:production` is the safe clean-checkout dry-run. For release
acceptance after provisioning, set `RC_MECH_REQUIRE_REMOTE_CONFIG=1`; that mode
requires all four production secret names,
and it requires `RC_MECH_DEPLOYED_URL`, `RC_MECH_OWNER_COOKIE`,
`RC_MECH_OWNER_CAR_ID`, `RC_MECH_OWNER_PHOTO_ID`, and
`RC_MECH_OTHER_OWNER_COOKIE`, and `RC_MECH_R2_PUBLIC_ACCESS_VALIDATED=1` after
an operator verifies that both `r2.dev` and custom-domain access are disabled.
It checks remote migration status, the R2 bucket,
the deployed passkey RP host, authenticated owner reads, and cross-owner
record/photo isolation. Email delivery still requires the operator to send and
redeem a real magic link; the release script deliberately does not send mail.
Do not put those cookie values in source, logs, or pull requests.

## Local browser integration

Run two terminals:

```sh
# terminal 1
pnpm worker:dev

# terminal 2
pnpm client:dev
```

Open `http://localhost:4200`. Angular's `src/proxy.conf.json` forwards
`/api/**` to Wrangler at `http://127.0.0.1:8787`, so cookies and API calls stay
same-origin from the browser shell. Direct Worker routes remain available at
`http://localhost:8787/api/docs`, `/api/openapi.json`, and
`/api/v1/health`; unknown `/api/*` paths must be JSON 404s, not Angular HTML.

For an isolated invite acceptance run, use the typed API seed CLI after the
local Worker is ready:

```sh
pnpm db:migrate:local
pnpm exec tsx scripts/invite-cli.ts \
  --url http://127.0.0.1:8787 \
  --owner-email owner@example.com \
  --code OWNER-01
```

The CLI requests and redeems the deterministic local magic link, then creates
the code through the authenticated invite-management endpoint. It does not
write production data or bypass the request boundary.

## Browser acceptance

Use an owner account and verify this sequence in a browser:

1. Request a magic link, complete sign-in, add a passkey, sign out, and sign
   back in with the passkey. Confirm rename, revoke, and magic-link recovery.
2. Create a car, edit its details, archive it, restore it, and confirm that
   another owner's car is never listed or addressable.
3. Install a component, edit it, replace it, and confirm the prior
   installation remains in component history.
4. Record, edit, and archive a drive session. Confirm timezone display and
   history behavior.
5. Create a maintenance plan, complete it once, and confirm the service
   record and baseline update. Add an ad hoc service record with notes and a
   paired cost/currency, then edit, archive, and restore it.
6. Upload, replace, reorder, designate-primary, and delete a car photo. Open
   the image and confirm it streams only while signed in as its owner. Verify
   an archived car is read-only and another owner cannot list or stream it.
7. Open `/api/docs` and `/api/openapi.json` from the deployed origin and check
   that the documented routes match the browser requests.

For the invite-specific sequence, verify that the Owner starts with an empty
invite history, User A registers with `OWNER-01`, creates a code, and User B
registers with that code. Confirm each user sees an empty garage and cannot
read the other user's cars or invite history. Reuse a redeemed code and try a
revoked code; both must remain neutral registration responses. Force a
reserved invite's `reserved_until` into the past in isolated local D1 before
retrying it, rather than waiting fifteen minutes. Creation stops after five
lifetime slots; redeemed and revoked slots remain consumed, while an expired
temporary reservation is released. Production email links must be requested
and redeemed by an operator with real Email Service delivery; the deterministic
local token is never a production verification mechanism.

Record the deployed URL, migration result, dry-run result, and any blocked
email, WebAuthn, or R2 steps with the release. Never put private photo bytes,
magic-link URLs, owner addresses, or production secrets in logs, screenshots,
issues, or pull requests.
