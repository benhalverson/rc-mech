# Angular feature architecture

**Status:** Accepted  
**Decision:** [ADR 0012](./adr/0012-thin-angular-components-and-feature-boundaries.md)

This is the implementation standard for the entire RC Mech Angular application. It applies to authenticated features, the root shell, and public authentication. Alloy remains the visual language for authenticated routes only; this architecture does not authorize a public sign-in redesign.

## Dependency direction

```text
User interaction
  -> component
  -> workflow store
  -> feature gateway or capability service
  -> external system

Reactive operation outcome
  -> workflow store
  -> component presentation
```

Dependencies do not point sideways between workflow stores or backward from a gateway into UI state.

## Responsibilities

| Layer | Owns | Does not own |
| --- | --- | --- |
| Component | Rendering, Signal Forms, local open/selected state, focus, accessibility, template-only computed state | HTTP, persistence, request sequencing, retries, concurrency, stale-response protection |
| Workflow store | Feature data, loading and failure state, commands, optimistic updates, concurrency, refreshes, typed operation outcomes | DOM, CSS classes, focus targets, endpoint construction, raw transport parsing |
| Feature gateway | URLs, credentials, `HttpClient`, reactive reads, mutation requests, Zod parsing, compatibility normalization | Workflow state, user-interface copy, form state |
| Capability service | One external capability such as recording, IndexedDB, authentication, files, imports, clipboard, or responsive observation | Unrelated capabilities or public feature state that belongs in a store |
| Pure module | Parsing, validation, calculations, command mapping, and data transformation | Injection, mutable application state, external side effects |

## Components

- One component represents one cohesive rendered responsibility.
- Approximately 200 lines is a decomposition-review signal, not a CI limit.
- Every component has an adjacent external `.html` template. Inline templates are prohibited.
- Inline component styles are prohibited. Tailwind handles normal styling; one adjacent `.css` file is allowed only when scoped CSS is technically unavoidable.
- Templates use native `@if`, `@for`, and `@switch` control flow and do not contain complex derivation.
- Components use signal-based `input()`, `model()`, and narrowly scoped intent `output()` APIs. Legacy `@Input()` and `@Output()` decorators are prohibited.
- Outputs communicate semantic user intent; they do not synchronize shared feature state.
- Signal Form state belongs to the smallest editor component that renders and validates the fields.
- Draft form state moves to a store only when it must survive navigation or coordinate across feature sections.
- Components may access the DOM when the behavior is intrinsically presentational, such as focus management or an ARIA relationship.
- Components do not call `HttpClient`, access persistence or external browser capabilities directly, manually subscribe, await a feature operation, sequence requests, retry work, manage cancellation, run workflow timers, or guard stale responses.
- UI-only Observables use the async pipe or `toSignal()`.
- Component effects are limited to presentation concerns such as focus and DOM synchronization.

## Stores and local reactive events

A route with remote data or a meaningful workflow receives a route-provided NgRx Signal Store. A static or trivial route does not receive a ceremonial store.

- A composite route provides one store per cohesive, independently changing workflow rather than one umbrella store.
- A narrow context store may expose state genuinely shared by those workflows.
- Workflow stores do not inject sibling workflow stores.
- Route or section containers may compose multiple stores.
- An explicit coordinator may invoke more than one store only for a genuine cross-workflow transaction.
- Stores use the appropriate RxJS flattening strategy when work must cancel, ignore, or serialize overlapping commands.
- Public feature state lives in stores, not writable service signals, `BehaviorSubject` instances, or mutable service collections.

“Event-driven” means a local reactive command-and-outcome flow. It does not mean a global event bus.

- A component invokes an immutable, feature-specific command and receives `void`.
- Commands use canonical RC Mech language and never contain DOM events, elements, Signal Form objects, component instances, or transport DTOs.
- A workflow exposes discriminated idle, pending, succeeded, and failed outcomes with operation identity.
- Components render outcome state and react only when presentation work such as closing an editor or moving focus is required.
- Promise-returning booleans, global `EventEmitter`, shared `Subject`, string event names, and implicit cross-feature broadcasts are not workflow contracts.

## Gateways and external capabilities

Feature gateways are the only client layer that understands transport and legacy response shapes.

- Gateways own endpoint construction, credentials, transport types, and `HttpClient`.
- Reactive reads use `httpResource`; mutations return cold Observables.
- Colocated Zod schemas parse every gateway response before it reaches a store.
- `httpResource` reads use its `parse` hook; mutation responses are parsed before emission.
- Canonical models are inferred from schemas where practical.
- Compatibility fields are normalized into the current feature model inside the gateway.
- Stores never construct URLs or parse raw transport responses.
- Gateways contain no form state, presentation language, or writable workflow state.
- Stateful gateways and stores share the lazy route lifetime so resources and pending work are discarded when the feature is left.

Root-provided services are reserved for genuinely application-wide capabilities such as session state, appearance preference, route announcements, and offline infrastructure. New singletons use the repository's `@Service()` convention. A capability service may retain private handles such as `MediaRecorder`, timers, or browser listeners when those values cannot belong in serializable state.

## Feature organization

Code is organized by route-level feature and then by cohesive workflow, never by global technical-type buckets.

```text
maintenance/
  maintenance.ts
  maintenance.html
  maintenance.routes.ts
  maintenance-context-store.ts
  plans/
    maintenance-plans.ts
    maintenance-plans.html
    maintenance-plans-store.ts
    maintenance-plans-api.ts
    maintenance-plans.models.ts
    maintenance-plans.rules.ts
    *.spec.ts
  service-history/
  consumables/
```

Components, stores, gateways, models, pure rules, and tests remain near the workflow they implement. Root-level feature components and forwarding wrappers are deleted after consumers move to the owning feature.

## Shared interface code

- Native semantic elements styled through Tailwind are the default building blocks.
- Feature-specific components stay in their feature.
- A component becomes shared only when it encapsulates repeated behavior, accessibility, or interaction—not appearance alone.
- RC Mech does not create generic card, button, field, or layout wrappers.
- Speculative abstractions and global `components/` or `services/` directories are prohibited.

## Testing

Tests follow the production seams and remain adjacent to the code they verify.

- Component tests use store fakes and verify rendered behavior, Signal Form interaction, focus, accessibility, and intent.
- Store tests use gateway fakes and verify loading, mutations, optimistic updates, concurrency, stale responses, refreshes, and operation outcomes.
- Gateway tests use Angular HTTP testing to verify endpoints, credentials, payloads, Zod parsing, and compatibility normalization.
- Pure modules are tested without TestBed.
- Route specs verify routing only.
- Shared test builders remove repetitive setup but never absorb feature assertions.
- Authenticated Playwright tests verify complete workflows and AXE behavior.
- The existing 100 percent per-file statement, branch, function, and line coverage gate remains unchanged.

## Automated enforcement

Biome remains the only general-purpose linter. A small TypeScript-AST architecture check runs through `pnpm lint`, identifies Angular components structurally, and rejects prohibited component dependencies and async orchestration without requiring filename conventions or ESLint.

The check enforces what can be determined statically, including direct component `HttpClient`, external-capability access, manual subscriptions, and inline templates or styles. Responsibility and the approximately 200-line review signal remain review concerns.

## Migration and legacy contraction

The refactor follows the Alloy route migration:

1. Add the architecture check, gateway pattern, and client Zod dependency.
2. Remove unused Angular Material, Angular Animations, and `provideAnimations()`; retain CDK while `BreakpointObserver` is active.
3. Refactor the root shell and public sign-in architecture without redesigning sign-in.
4. Refactor each authenticated route while implementing its Alloy slice.
5. Contract obsolete components, wrappers, compatibility code, dependencies, styles, tests, and documentation after their final consumers are gone.

A legacy path is removed only when all applicable evidence exists:

- No static or lazy-loaded consumer remains.
- No production data requires its compatibility reader.
- Required persisted-data migration has been verified.
- Old URLs have an explicit removal or redirect decision.
- Tests and fixtures no longer encode the obsolete behavior.
- Dependencies, styles, documentation, and adapters used only by the path are removed in the same contraction step.
- Current user capabilities remain intact.

The frontend adopts the glossary's canonical **Drive session** term. Components, stores, fields, tests, and copy stop using **Run** for that concept. `/garage/:carId/drive-sessions` becomes canonical; `/garage/:carId/runs` redirects during a compatibility window and is removed only after the evidence above exists. Unrelated platform methods named `run` are unaffected.

## Audit baseline

The 2026-08-08 audit identified the following priority migration seams:

| Current file | Size | Main boundary problem |
| --- | ---: | --- |
| `maintenance-cockpit.ts` | 773 lines | Plans and service workflows, forms, direct HTTP, and presentation combined |
| `consumable-maintenance.ts` | 565 lines | Reporting, form workflow, direct HTTP, and presentation combined |
| `setup-snapshots.ts` | 519 lines | Setup editing, import review, request orchestration, and presentation combined |
| `car-photo-gallery.ts` | 332 lines | Upload workflow, direct HTTP, confirmation, and gallery presentation combined |
| `car-build.ts` | 290 lines | Form workflow and direct mutations remain in the route component |
| `sign-in.ts` | 285 lines | Authentication transport, passkey browser APIs, forms, and presentation combined |
| `car-runs.ts` | 274 lines | Drive-session form workflow and direct mutations remain in the route component |
| `voice-track-log.ts` | 237 lines | Voice presentation depends directly on a sibling Drive-session store |
| `car-routes.spec.ts` | 2,385 lines | Multiple routes, components, stores, and workflows share one catch-all spec |

The root-level `maintenance-cockpit`, `consumable-maintenance`, `setup-snapshots`, and `car-photo-gallery` components and their forwarding wrappers are removed as their feature slices migrate.

## Completion contract

The migration is complete only when:

- No Angular component directly uses `HttpClient`, manually subscribes, awaits feature operations, or owns workflow concurrency.
- No inline component template or style remains.
- Oversized route components have been split by rendered responsibility.
- Stateful workflows use route-provided stores and focused gateways.
- Stores do not inject sibling workflow stores.
- Root-level legacy feature components and forwarding wrappers are gone.
- Tests are colocated and catch-all feature specs are split.
- Drive session is canonical throughout relevant frontend language, with only the approved temporary redirect remaining.
- Angular Material and Angular Animations are removed, while active nonvisual CDK use remains.
- The architecture check, build, formatting, 100 percent per-file coverage, Playwright, AXE, and diff checks pass.
- Existing user capabilities and required production-data compatibility remain intact.
