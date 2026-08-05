# RC Mech development guidance

These guidelines apply to the Angular frontend in `client/` and to TypeScript code generally.

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
- Use `input()` and `output()` functions instead of input/output decorators.
- Use `model()` for two-way bound properties with `[(prop)]` syntax instead of pairing `input()` with `output()`.
- Use `computed()` for derived state.
- Use `linkedSignal()` when state derived from multiple reactive sources must stay synchronized.
- Prefer inline templates for small components.
- Prefer Signal Forms from `@angular/forms/signals` for new forms. Signal Forms are stable in Angular v22+, and provide signal-based field access and schema-based validation.
- When Signal Forms are not used, prefer Reactive Forms over template-driven forms.
- Do not use `ngClass`; use class bindings.
- Do not use `ngStyle`; use style bindings.
- When using external templates or styles, use paths relative to the component TypeScript file.

## Accessibility

- Frontend changes must pass all AXE checks.
- Follow WCAG AA minimums, including focus management, color contrast, and appropriate ARIA attributes.

## State management

- Use signals for local component state.
- Use `computed()` for derived state.
- Keep state transformations pure and predictable.
- Do not mutate signal values; use `update()` or `set()`.

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
