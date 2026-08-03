# Production deployment and browser acceptance

Issue #11 is a release checklist for the single-Worker application. The
Angular build is copied into `public/`; Wrangler serves those files through
the same origin as the authenticated API. Do not deploy a separately hosted
Angular shell or change the browser's relative `/api/...` URLs.

## Production configuration

Create the resources once, then replace the placeholder D1 ID in the
production Wrangler configuration:

```sh
pnpm exec wrangler d1 create rc-mech
pnpm exec wrangler r2 bucket create rc-mech-photos
pnpm exec wrangler d1 migrations apply DB --remote --env production
```

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
pnpm exec wrangler secret put APP_URL --env production
pnpm exec wrangler secret put BETTER_AUTH_SECRET --env production
pnpm exec wrangler secret put OWNER_EMAIL --env production
pnpm exec wrangler secret put EMAIL_FROM --env production
```

Before deployment, run the clean-checkout checks and build the static shell:

```sh
pnpm install --frozen-lockfile
pnpm cf-typegen
pnpm db:migrate:local
pnpm check
pnpm client:build
pnpm exec wrangler deploy --dry-run --env production
pnpm deploy
```

`public/.gitignore` keeps generated Angular bundles untracked while retaining
the directory marker. A successful build should not dirty tracked files.

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

Record the deployed URL, migration result, dry-run result, and any blocked
email, WebAuthn, or R2 steps with the release. Never put private photo bytes,
magic-link URLs, owner addresses, or production secrets in logs, screenshots,
issues, or pull requests.
