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

For local database work, use `pnpm db:migrate:local`. To inspect or reset local D1, use Wrangler's local commands, for example `pnpm exec wrangler d1 migrations list DB --local`. This issue intentionally keeps the existing `rc-mech-photos` R2 bucket binding and placeholder D1 ID; it does not provision remote resources. Issue #11 should create the production resources and replace the placeholder with commands such as:

```sh
pnpm exec wrangler d1 create rc-mech
pnpm exec wrangler r2 bucket create rc-mech-photos
```

Set `APP_URL`, `BETTER_AUTH_SECRET`, `OWNER_EMAIL`, and `EMAIL_FROM` in the production Worker environment; `APP_URL` is deliberately not given a localhost production default because it controls magic-link redirects, trusted origins, cookies, and passkey RP identity. Local development uses Wrangler's `local` environment and intentionally sends no email. Do not commit sender or owner addresses.
