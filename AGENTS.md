# RC Mech development guidance

These guidelines apply to the Angular frontend in `client/` and to TypeScript code generally.

The complete frontend boundary and migration standard is documented in [Angular feature architecture](docs/angular-feature-architecture.md).

## TypeScript

- Use strict type checking.
- Prefer type inference when the type is obvious.
- Avoid `any`; use `unknown` when a value's type is uncertain.

## Angular

- Use standalone components instead of NgModules.
- Do not set `standalone: true` inside Angular decorators; it is the default in Angular v20+.
- Do not explicitly set `changeDetection: ChangeDetectionStrategy.OnPush`; OnPush is the default in Angular v22+.
- Use signals for state management.
- Implement lazy loading for feature routes.
- Do not use `@HostBinding` or `@HostListener`; put host bindings in the `host` object of the component or directive decorator.
- Use `NgOptimizedImage` for all static images. It does not support inline base64 images.
- Keep components small and focused on one responsibility.
- Never use legacy `@Input()` or `@Output()` decorators. Use signal-based `input()`, `model()`, and narrowly scoped intent `output()` APIs.
- Use `model()` for two-way bound properties with `[(prop)]` syntax instead of pairing `input()` with `output()`.
- Use `computed()` for derived state.
- Use `linkedSignal()` when state derived from multiple reactive sources must stay synchronized.
- Use an external template for every component; do not use inline templates.
- Do not use inline component styles. Use Tailwind for normal styling and an adjacent external CSS file only when scoped CSS is technically unavoidable.
- Prefer Signal Forms from `@angular/forms/signals` for new forms. Signal Forms are stable in Angular v22+, and provide signal-based field access and schema-based validation.
- When Signal Forms are not used, prefer Reactive Forms over template-driven forms.
- Do not use `ngClass`; use class bindings.
- Do not use `ngStyle`; use style bindings.
- Use paths relative to the component TypeScript file for external templates and styles.

## Accessibility

- Frontend changes must pass all AXE checks.
- Follow WCAG AA minimums, including focus management, color contrast, and appropriate ARIA attributes.

## State management

- Use signals for local component state.
- Use `computed()` for derived state.
- Keep state transformations pure and predictable.
- Do not mutate signal values; use `update()` or `set()`.
- Use a route-provided NgRx Signal Store for a route with remote data or a meaningful workflow; do not create stores for static or trivial routes.
- Use one store per cohesive workflow. Stores must not inject sibling workflow stores; use narrow shared context or an explicit coordinator when necessary.
- Store commands accept immutable feature commands, return `void`, and publish typed reactive outcomes.
- Keep DOM, CSS, focus, and other presentation state out of stores.

## Component boundaries

- Components own rendering, Signal Forms, local interaction state, focus, accessibility, and template-only computed state.
- Components must not use `HttpClient`, persistence, external browser capabilities, manual subscriptions, or feature-operation promises directly.
- Event handlers validate and focus local fields, then invoke one store command.
- Keep Signal Form state in the smallest editor component that renders the fields unless the draft must survive navigation or coordinate across sections.
- Treat approximately 200 lines as a decomposition-review signal, not a CI limit.
- Use native semantic elements and Tailwind before creating shared Angular UI wrappers.

## Templates

- Keep templates simple and avoid complex logic.
- Use native control flow (`@if`, `@for`, and `@switch`) instead of structural directive equivalents.
- Use the async pipe to handle observables.
- Do not assume browser globals such as `new Date()` are available in templates.

## Services

- Design services around one responsibility.
- Use `providedIn: 'root'` for singleton services.
- Prefer the `@Service` decorator over `@Injectable({ providedIn: 'root' })` for new singleton services in Angular v22+.
- Use `inject()` instead of constructor injection.
- Put endpoint construction, `HttpClient`, Zod response parsing, and compatibility normalization in feature gateways.
- Use `httpResource` for gateway reads and cold Observables for gateway mutations.
- Do not use service state as a substitute for NgRx Signal Store state. Private capability handles are allowed when required by an external API.

## Project structure and tests

- Organize code by route-level feature and cohesive workflow, not global technical-type folders.
- Colocate components, stores, gateways, models, pure rules, and their focused specs.
- Keep route specs limited to routing and avoid catch-all feature specs.
- Preserve the configured 100 percent per-file Angular coverage gate.
