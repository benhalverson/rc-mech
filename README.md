# RC Mech

RC Mech is a local-first garage and maintenance notebook for radio-controlled cars. The Angular-ready dashboard assets and Hono API are served by one Cloudflare Worker.

This is an example project made to be used as a quick start into building OpenAPI compliant Workers that generates the
`openapi.json` schema automatically from code and validates the incoming request to the defined parameters or request body.

## Get started

1. Install dependencies with `pnpm install --frozen-lockfile`.
2. Generate bindings with `pnpm cf-typegen`.
3. Apply the local D1 migration with `pnpm db:migrate:local`.
4. Start the API and Angular in two terminals:
   - API: `pnpm worker:dev` (Wrangler local environment at `http://localhost:8787`).
   - Angular: `pnpm client:dev` (or `pnpm --dir client start`) at `http://localhost:4200`.

## Project structure

The domain terms are defined in [CONTEXT.md](./CONTEXT.md). Architectural choices are recorded in [docs/adr](./docs/adr). The API is documented at `/api/docs` and `/api/openapi.json`.

## Development

The Angular CLI workspace lives in `client/`. Its production build writes directly to `public/`, the directory configured as the Worker static-assets directory. Angular source is excluded from the root Worker TypeScript compilation.

Use `pnpm client:build` for a production build, `pnpm worker:dev` for Wrangler local development, and `pnpm check:client` for the client build check. During local development, Angular's dev server proxies `/api/**` to the Worker at `http://127.0.0.1:8787` using `client/src/proxy.conf.json`, so the browser shell keeps its relative `/api/...` requests and avoids a separate CORS boundary.

Worker routing owns `/api/docs`, `/api/openapi.json`, `/api/auth/*`, and `/api/v1/*`. Unknown API paths return JSON `404` responses. Non-API paths fall through to `env.ASSETS.fetch()`, with the Worker applying Angular's HTML fallback only to non-API browser navigations.

After the first magic-link sign-in, add one or more named passkeys from the dashboard. The browser owns the WebAuthn ceremony, including its standard cross-device or QR handoff where supported. Passkeys can be renamed or revoked; magic-link sign-in remains the recovery path. Verify this manually in a WebAuthn-capable browser: sign in by magic link, add a passkey, sign out, sign in with the passkey, rename and revoke it, confirm it disappears from the list, and confirm a new magic link still signs you in.

The Worker has a typed `EMAIL` Cloudflare Email Service seam in [src/email.ts](./src/email.ts). It is intentionally a no-op in local development when the binding is unavailable, while deployed magic-link requests fail closed unless `EMAIL_FROM` and the binding are configured. Do not commit sender or owner addresses.

For local database work, use `pnpm db:migrate:local`. To inspect or reset local D1, use Wrangler's local commands, for example `pnpm exec wrangler d1 migrations list DB --local`.

## Production setup and acceptance

Production uses one Worker with four bindings: D1 `DB` for relational data, private R2 `PHOTOS` for car photos, Email Service `EMAIL` for magic links, and static assets `ASSETS` from `./public`. The checked-in Wrangler file intentionally contains a non-production D1 placeholder because resource IDs and domains belong to the deployment account; never deploy production with that placeholder.

Create the account resources, then replace the D1 ID in both the top-level and `env.production.d1_databases` entries and use the real R2 bucket name:

```sh
pnpm exec wrangler d1 create rc-mech
pnpm exec wrangler r2 bucket create rc-mech-photos
```

Apply migrations to the remote database before the first deploy:

```sh
pnpm exec wrangler d1 migrations apply DB --remote --env production
```

Configure the Email Service sender in the Cloudflare dashboard/API, bind it as `EMAIL`, and set these production-only values as Worker secrets/vars. `APP_URL` must be the final HTTPS origin, including the custom domain used by the dashboard; it controls redirects, trusted origins, cookies, and passkey RP identity.

```sh
pnpm exec wrangler secret put BETTER_AUTH_SECRET --env production
pnpm exec wrangler secret put OWNER_EMAIL --env production
pnpm exec wrangler secret put EMAIL_FROM --env production
pnpm exec wrangler secret put APP_URL --env production
```

`APP_URL` is shown as a secret command to keep it out of source; it may instead be a reviewed non-secret production var if the deployment policy permits. `OWNER_EMAIL` and `EMAIL_FROM` must be real addresses accepted by the configured Email Service sender. Do not commit any of these values.

Attach the Worker to the chosen HTTPS domain through the Cloudflare Workers custom-domain or route configuration, then deploy with `pnpm deploy`. Validate the configuration without changing Cloudflare state with `pnpm test:production`; set `RC_MECH_DEPLOYED_URL=https://your-domain.example pnpm test:production` to also check health, docs, unauthenticated API rejection, private-photo rejection, and JSON API 404 behavior. For a release check, set `RC_MECH_REQUIRE_REMOTE_CONFIG=1` plus the deployed URL, owner session cookie/car/photo IDs, a second-owner session cookie, and `RC_MECH_R2_PUBLIC_ACCESS_VALIDATED=1` after verifying the bucket has no public r2.dev or custom-domain access; this mode fails closed on the placeholder D1 ID or missing production secret names, remote migration/R2 checks, deployed passkey RP host, authenticated owner reads, and cross-owner record/photo isolation. Email delivery and a real passkey ceremony remain operator checks because automation would send real mail or require a browser credential. The full local authenticated lifecycle smoke remains `pnpm test:auth:e2e`; it creates only local D1/R2 test data.

The complete release and browser checklist is in [docs/production-acceptance.md](./docs/production-acceptance.md). To make the production-resource check fail when the placeholder ID is still present, run `RC_MECH_REQUIRE_REMOTE_CONFIG=1 pnpm test:production` after account provisioning.
