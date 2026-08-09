# ADR 0010: Use the Alloy Run Console interface globally

- Status: Accepted
- Date: 2026-08-08

## Context

The frontend needs one distinctive visual system across the authenticated application. The Alloy Run Console prototype established the chosen direction, while Angular Material would impose a competing visual language and make that direction harder to maintain consistently.

## Decision

Use the Alloy Run Console visual system for Garage, car, Maintenance, and Settings pages. Implement its graphite, aluminum, steel, and desaturated-teal palette through Tailwind CSS v4 tokens and utilities. Use Commissioner for interface text and Fragment Mono only for measurements, run counts, timestamps, and similarly technical values.

“Alloy Run Console” is an internal name for the visual system, not product terminology. User-facing copy continues to use the glossary term “Drive session” rather than “Run,” including session history and session-capture actions.

Do not use Angular Material visual components. Feature layouts may respond to their content, but they must remain recognizably part of the Run Console through the same typography, ruled structure, control treatments, density, and interaction states. The root `App` continues to own application navigation and responsive shell behavior.

On desktop, primary navigation lives in the graphite top command bar rather than a global left sidebar. A left rail is reserved for contextual choices within the current feature, such as selecting a car or maintenance view; it must not duplicate primary navigation. On mobile, the command bar uses the existing accessible drawer behavior and each feature presents its contextual choices in a narrow-screen-appropriate form.

Mobile trackside use is the primary responsive constraint. Selecting a car, recording a drive session, reviewing a voice draft, and checking the current setup must be direct mobile workflows. Narrow layouts use one active pane and deliberately recompose the console instead of shrinking or horizontally compressing the desktop rail-and-workspace layout.

The selected-car center is a functional setup sheet, not a decorative chassis illustration. The prototype route, fake records, variant switcher, alternate skins, and prototype-only styling are not production architecture and are removed after recording this decision.

## Consequences

Shared Tailwind patterns will cover controls and recurring states, while feature templates own their layouts. Angular CDK may remain for nonvisual behavior, but the unused Angular Material dependency should be removed once current usage is confirmed absent. Any new visual pattern must fit Alloy rather than introduce another theme. Detailed visual and interaction rules live in `docs/alloy-run-console-design-system.md`.
