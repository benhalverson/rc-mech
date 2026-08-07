# Frontend architecture verification

**Issue:** #52
**Verified:** 2026-08-07

## Route and state boundaries

- The root route table contains public sign-in plus protected lazy route boundaries. Garage, maintenance, settings, and each car section load through their own route file.
- `canMatch` protects every private root boundary before Angular requests its feature component. The signed-out browser path `/garage/private-car/photos` redirects to `/sign-in?returnTo=...`; route tests also verify that the protected loader is not invoked.
- Feature reads live in route-provided stores or narrow lookup adapters. View components retain only imperative writes and browser ceremonies such as passkey credential exchange.
- The root component owns the one authenticated workspace shell. Feature components no longer parse root URLs, duplicate that shell, or coordinate unrelated workspaces.

## Angular conventions

- Components rely on Angular's standalone and OnPush defaults; no decorator sets `standalone` or `changeDetection` explicitly.
- New and migrated forms use Signal Forms. The client contains no `FormsModule`, `ngModel`, `@HostBinding`, `@HostListener`, `ngClass`, or `ngStyle` usage.
- Local and derived state use signals and computed values. Read transformations are isolated in stores or pure functions.
- The only application `<img>` displays an authenticated, user-uploaded car photo from a dynamic API URL. `NgOptimizedImage` is therefore not applicable to the current image inventory; there are no static application images.

## Accessibility and navigation

The browser acceptance test checks the following with AXE:

- the signed-out deep-link redirect and sign-in page;
- direct deep links to Overview, Build, Setups, Photos, and Runs;
- Garage, Maintenance, and Settings workspaces;
- owner and invited-user states, including garage isolation.

Each car deep link must move focus to its `data-route-focus` heading and publish its route change through the polite live region. Initial authenticated navigation waits for a lazily rendered heading before moving focus. Heading levels in the Setups and Photos sections follow the car shell's heading hierarchy.

## Bundle evidence

`pnpm client:build` produces the Angular application in `public/`.

| Measurement | Issue baseline | 2026-08-07 result |
| --- | ---: | ---: |
| Initial raw bundle | 648.75 kB | 212.02 kB |
| Initial transfer estimate | not recorded | 53.53 kB |
| Warning budget | 600 kB | 600 kB |

The initial raw bundle is 436.73 kB (67.3%) smaller than the baseline and is 387.98 kB below the warning budget. No budget exception is required.

The production build reports named lazy chunks for `maintenance`, `settings`, `sign-in`, `garage`, `car-overview`, `car-build`, `car-setups`, `car-photos`, and `car-runs`, plus their shared dependencies.

## One deployment

[ADR-0001](./adr/0001-single-worker-angular-assets.md) remains the deployment decision. Angular writes to `public/`; `wrangler.jsonc` binds that same directory as `ASSETS` and uses `src/index.ts` as the Worker entrypoint. The managed `pnpm deploy` command builds those assets, applies the remote D1 ledger, and deploys one Worker. No second frontend runtime or origin is introduced.

## Verification commands

```sh
pnpm check:client
pnpm test:backend
pnpm test:invite:browser
pnpm check
git diff --check
```

The browser command prints existing `NO_COLOR`/`FORCE_COLOR` runner warnings. `pnpm check` also reports Wrangler's multiple-environment warning because its dry-run intentionally targets the top-level production configuration. These are warnings, not clean output; each command must still report a passing test or successful dry-run result.
