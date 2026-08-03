# RC Mech

RC Mech is a local-first garage and maintenance notebook for radio-controlled cars. The Angular-ready dashboard assets and Hono API are served by one Cloudflare Worker.

This is an example project made to be used as a quick start into building OpenAPI compliant Workers that generates the
`openapi.json` schema automatically from code and validates the incoming request to the defined parameters or request body.

## Get started

1. Install dependencies with `pnpm install`.
2. Generate bindings with `pnpm cf-typegen`.
3. Apply the local D1 migration with `pnpm db:migrate:local`.
4. Start the dashboard and API with `pnpm dev`.

## Project structure

The domain terms are defined in [CONTEXT.md](./CONTEXT.md). Architectural choices are recorded in [docs/adr](./docs/adr). The API is documented at `/api/docs` and `/api/openapi.json`.

## Development

Run `pnpm check` before publishing. Set `BETTER_AUTH_SECRET` as a Worker secret for deployed environments; local development uses the documented development fallback.
