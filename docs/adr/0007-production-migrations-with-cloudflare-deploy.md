# Apply remote D1 migrations as part of the Cloudflare deployment

Production D1 migrations run from the existing Cloudflare-managed deployment,
immediately before the Worker deploy. The deployment always invokes Wrangler's
remote migration command, whose D1 migration ledger skips applied migrations
and applies pending ones; a migration failure prevents the Worker deploy. This
keeps production credentials out of GitHub and requires migrations to use an
expand/deploy/contract sequence so the currently deployed Worker remains
compatible if the new Worker deployment fails.
