# Alloy Run Console design system

Status: Visual direction approved; ready for implementation planning

Alloy Run Console is the single visual system for Chassis Notes' authenticated interface. It presents the garage as a precise trackside instrument: useful information is prominent, controls are direct, and decoration never imitates data.

## Design-review scope

This review defines visual hierarchy, typography, color, spacing, responsive composition, component appearance, interaction feedback, and accessibility. Product behavior and record-lifecycle rules are separate concerns and are not expanded as part of the visual-system review.

## Foundation

- Tailwind CSS v4 is the visual implementation layer. Angular Material visual components are not part of the design system.
- Graphite (`#171b1d`) anchors command surfaces and selected states.
- Aluminum (`#d9dcdd`) is the primary workspace surface.
- Alloy (`#c8cccd`) separates contextual rails and supporting regions.
- Instrument teal (`#3f646e`) identifies primary actions and active work.
- Deep teal (`#294d58`) provides accessible emphasis on light surfaces.
- Steel (`#8b9996`) supports secondary information.
- Commissioner is the interface typeface. Fragment Mono is restricted to measurements, drive-session counts, timestamps, and similarly technical values.
- Bright yellow and red are not part of the core palette. Meaning must never rely on color alone.
- Gradients, glow, ornamental technical diagrams, and generic card grids are excluded.

Alloy is an abstract instrument-panel language, not a literal metal simulation. Use flat, precise surfaces, restrained inset highlights, and controlled separators. Do not use brushed-metal textures, faux bolts, heavy bevels, or metallic gradients.

Alloy provides complete light and dark appearances. Unless the user has made an explicit appearance choice, the interface follows the operating system's light/dark preference and responds when that system preference changes. The light and dark palettes preserve the same hierarchy and desaturated-teal identity; dark mode is designed independently rather than produced by mechanically inverting the light palette.

The appearance control has three explicit choices: `System`, `Light`, and `Dark`. `System` is the default and continues tracking operating-system changes. Selecting `Light` or `Dark` creates a persistent override, and the control always makes the current preference visible so returning to automatic selection is unambiguous.

The dark appearance uses a deep-graphite tonal stack instead of pure black:

- Canvas: `#111516`
- Primary surface: `#191f21`
- Raised controls: `#22292b`
- Primary text: `#e6e9e8`
- Secondary text: `#a6b0ae`
- Dark-mode teal: `#78a4ad`

These tones must remain visibly distinct in ordinary and low-brightness viewing conditions; dark mode must not collapse the canvas, surfaces, and controls into one black field.

The light appearance uses a cool layered-metal stack instead of a white canvas:

- Canvas and contextual rails: `#c8cccd`
- Primary workspace: `#d9dcdd`
- Fields and raised controls: `#edf0ef`
- Primary text: `#171b1d`
- Secondary text: `#4f5c5b`
- Separators: `#a8b1af`
- Light-mode active teal: `#294d58`

The graphite command bar remains the strongest visual anchor in the light appearance.

### Semantic states

Yellow and red are excluded from semantic states as well as the core palette. Teal identifies active, selected, recording-ready, and successful states.

Warnings use an explicit `Attention` label, an alert icon, and a stronger neutral boundary. Errors use an explicit `Error` label, an icon, and a high-contrast graphite/aluminum treatment. Destructive actions remain neutral in color and use specific labels such as `Delete voice note`. Do not use large tinted alert panels, and never rely on color alone to communicate state.

## Shape language

Alloy uses restrained industrial geometry:

- Fields, buttons, and compact controls use a `4px` corner radius.
- Sheets, dialogs, and major panels use an `8px` corner radius.
- Full pills are reserved for switches, status markers, and segmented selections whose shape communicates their control type.
- Oversized squircles, pill-shaped primary actions, and grids of rounded cards are excluded.

Shape communicates structure rather than decoration. A container is introduced only when grouping or interaction requires a boundary.

## Depth and boundaries

Alloy is predominantly flat. Separate page regions with tonal shifts, spacing, and precise inset rules rather than shadows. Inline panels, setup rows, fields, and buttons do not cast shadows.

Soft elevation is reserved for elements that genuinely float above the current context: dialogs, drawers, menus, and sheets. Do not use nested double-bezel containers, stacked-card effects, or decorative depth.

## Typography

Alloy uses a compact, mobile-first type hierarchy:

- Screen title: Commissioner, `26px/30px`, weight `650`.
- Section heading: Commissioner, `12px/16px`, weight `600`, uppercase with restrained tracking.
- Body: Commissioner, `15px/22px`, weight `450`.
- Labels and controls: Commissioner, `14px/20px`, weight `550–600`.
- Measurements and timestamps: Fragment Mono, `15px/20px`, weight `400`.
- Supporting text never drops below `13px`.

Avoid marketing-scale display type, tiny eyebrow chips, and all-uppercase body copy. Fragment Mono identifies technical values; it is not a decorative technology signal and must not spread to navigation, headings, or prose.

## Spacing and density

Alloy uses a compact `4px` base rhythm:

- Mobile page gutter: `16px`.
- Related elements: `8px`.
- Control groups: `16px`.
- Major mobile sections: `24px`.
- Desktop page gutters and major separation: `32px`.
- Interactive rows: at least `48px` tall.

Avoid both oversized presentation whitespace and cramped controls. Density comes from alignment, grouping, and a consistent vertical rhythm rather than removing usable touch space.

## Control hierarchy

- Each action group has at most one solid-teal primary action.
- Secondary actions are transparent with a neutral boundary.
- Tertiary actions are text-only but retain a complete touch target.
- Icon-only controls use a simple line icon, an accessible name, and a `48px × 48px` target on mobile.
- All mobile controls are at least `48px` tall.

Do not use nested icon bubbles, ornamental split-button treatments, or multiple competing filled actions.

## Iconography

Use `@lucide/angular` as Alloy's single icon source. Do not mix it with Material Icons, emoji, a second icon library, or hand-authored replacements for icons already available in Lucide.

## Motion

- Micro feedback: `120ms`.
- Exit transitions: `160–180ms`.
- Spatial transitions: `220ms`.
- Continuous motion: only for live or ongoing state.

Do not use page-load reveals, staggered entrance animations, decorative hover movement, scroll-triggered effects, or gratuitous spring and bounce effects.

When `prefers-reduced-motion` is active, remove spatial movement and nonessential transitions. Preserve immediate state changes and essential live-state indication, but never make motion the only indication that a live process is active.

## Focus indication

Keyboard focus uses a `2px` outer ring with a `2px` surface-colored offset. The ring is deep teal in light mode and light teal in dark mode, appears through `:focus-visible`, and is never replaced by shadow alone. Selection uses fill while focus uses the outer ring so the two states remain distinguishable when they occur together.

## Form fields

- Labels remain visible above fields; do not use floating labels or placeholders as labels.
- Controls are at least `48px` tall with `12px` horizontal padding.
- Technical values use Fragment Mono; ordinary text uses Commissioner.
- Recorded units remain visible as part of the value rather than becoming detached decorative suffixes.
- Help and error text appears directly below the field it describes.
- Fields use one clear neutral boundary; the teal focus ring supplies active emphasis.

## Product language

“Alloy Run Console” is an internal design-system name. User-facing copy uses the canonical term “Drive session,” never “Run,” for recorded driving activity.

## Application shell

- Alloy applies to Garage, car, Maintenance, and Settings pages.
- The root `App` owns the primary navigation and responsive navigation state.
- Desktop primary navigation occupies a graphite top command bar.
- Desktop left rails are contextual to the current feature and never duplicate primary navigation.
- Mobile retains an accessible navigation drawer from the command bar.

On car-related mobile screens, one `56px` sticky graphite command bar combines the menu control, current car name, car-picker chevron, and an optional overflow action. Do not stack a global header above a second sticky car selector. Appearance controls live in Settings rather than occupying this trackside command bar.

## Responsive model

Mobile trackside use is the primary constraint. Mobile layouts are purposefully recomposed into one active pane rather than compressed versions of the desktop console.

Alloy has two responsive compositions. Below `1024px`, phone and tablet layouts use the same one-pane shell with no persistent rail. At `1024px` and above, the desktop command bar and contextual left rail appear. Do not introduce an intermediate tablet-specific hybrid.

On car-related pages below `1024px`, the current-car control is integrated into the single sticky command bar and opens a full-width car-picker sheet. This keeps the selected car visible without stacking sticky bars and scales to garages with many cars. Desktop uses a contextual car rail.

## Content rule

Every prominent surface must communicate real Chassis Notes state or provide a real action. The selected-car workspace uses a functional current-setup sheet; it does not contain the prototype's decorative chassis illustration. Production UI must not introduce fake track, weather, heat, car, setup, or drive-session data.

## Selected-car information hierarchy

The current setup is the first and most prominent information after selecting a car. Voice notes are also a primary feature and receive a prominent capture surface on the selected-car screen without displacing the setup readout.

The setup readout follows this order:

1. Ride height
2. Camber
3. Front toe
4. Rear toe
5. Shock package, including the springs and shock oil used
6. Gear differential or center-drive configuration
7. Every remaining value in the full setup sheet

On mobile, render the setup readout as one compact instrument table rather than a grid of individual cards. Rows are 48–52 px tall, with labels aligned left, technical values aligned right in Fragment Mono, and restrained steel separators establishing rhythm. The rows remain comfortably tappable without turning each value into an oversized tile.

Ride height is one chassis value, such as 12 mm or 14 mm. It is not displayed or stored as separate front and rear values.

Camber displays front and rear values together. Rear toe is a structured physical setting rather than one scalar value: the summary shows the current setup sheet's pill position for both the rear C block and rear D block, such as `C · up/in` and `D · center/in`. It preserves the recorded positions exactly and does not calculate or display a derived toe angle.

The drivetrain readout follows the current setup sheet rather than forcing fixed differential slots. A 2WD car shows gear-differential oil and height. A 4WD car shows the oil for each applicable front, center, and rear gear differential. When the center drive is a decoupled center slipper, the summary identifies that configuration and does not show center oil as missing.

The current setup sheet is the sole source for the drivetrain summary. Chassis Notes does not add a car-level 2WD/4WD classification or infer drivetrain from the car's make, model, or vehicle type. When drivetrain data is absent from the current setup, the summary says `Not recorded` and provides a direct path to edit that setup.

Preserve measurement units exactly as recorded by the setup sheet and never convert between systems or conventions. The interface may normalize spacing and capitalization, but values such as `35 wt`, `450 cSt`, `7k`, and `12 mm` remain distinct recorded values.

The first values must be readable without opening the full setup sheet. When a priority value is missing from an existing current setup, keep its fixed position in the readout, label it `Not recorded`, and provide a direct correction path. Omit only drivetrain positions that the setup sheet identifies as genuinely non-applicable; never infer a value.

Immediately below the priority readout, show `Changes from previous` when the current setup was copied from another setup. List only fields whose recorded values changed, using an old-to-new form such as `Ride height · 12 mm → 14 mm`. Keep the current values visually primary and do not add change badges to every field. Do not call this a diff, because `diff` means differential in the Chassis Notes domain.

On mobile, the selected-car content order is current setup, `Changes from previous`, prominent voice-note capture, then one actionable maintenance item when maintenance is due or overdue. When nothing needs attention, the primary screen ends after voice capture rather than filling the space with secondary information. Do not reserve permanent dashboard space for an empty maintenance state.

On desktop, the setup workspace and voice-note capture may sit side by side, but the setup remains first in DOM and reading order.

Manual drive-session logging and session history are secondary utilities available through secondary navigation. Voice notes are not secondary: capture is front and center on the selected-car screen while the current setup remains the first information.

The selected-car screen has no persistent floating action. The setup readout itself starts `Change setup` when a value is tapped, and the section header includes one ordinary `Change setup` action for discoverability. Secondary utilities remain in secondary navigation.

When a car has no current setup, replace the setup readout with one focused `No current setup` state. `Record setup` is the primary setup action and `Import setup` is secondary. Do not render a grid of empty measurements; the separate voice-note capture surface remains available.

## Setup interactions

Tapping a recorded or missing value in the current-setup readout starts `Change setup`. Chassis Notes copies the current setup into a new snapshot and opens a focused editor at the selected field; it never silently mutates the historical snapshot.

The focused field is only the editor's starting point. The user may change multiple setup values before saving, and one save creates one coherent setup snapshot containing the complete resulting configuration.

After `Change setup` saves successfully, the new snapshot becomes the car's current setup in the same operation. Canceling the editor or failing to save leaves the previous current setup unchanged.

Naming never blocks a mobile setup change. Pre-fill a unique name from the previous setup name and the garage's local timestamp, such as `Clay baseline · Aug 8, 2:14 PM`. The user may rename it before saving but is not required to type a name.

Rear toe editing uses two explicitly labeled controls, one for the C block and one for the D block. Each is a 3×3 position selector crossing `up / center / down` with `in / center / out`. Always show the selected position as text as well as spatially; do not use a free-text toe field or rely on a diagram alone.

`Correct record` is a separate, explicitly labeled action available from setup history. Use it only to repair a recording mistake in the selected historical setup, never for normal tuning work.

## Voice-note capture

Preserve the existing tap-to-start/tap-to-stop recording behavior. `Start voice note` enters an unmistakable live state with a visible microphone-level meter, elapsed timer, recording label, `Stop and keep recording`, and `Cancel`. Do not use press-and-hold recording.

The microphone meter must expose a textual status such as `Audio detected`, `Speak to test the microphone`, or `Microphone muted`; visual movement alone is not sufficient feedback.

After `Stop and keep recording`, keep the user on the selected-car screen and transition the capture surface into inline review. Show the voice transcript alongside every proposed structured record and require explicit confirmation before creating a Setup change or adding any other garage record. Nothing applies automatically.

Speech-to-text is transcription only. A separate extraction step may map facts the user explicitly stated into a Voice draft, but transcription and extraction must never provide setup guidance, recommend tuning changes, invent values, or tell the user what to try next.

Only explicit statements of completed changes become structured proposals. For example, `The rear stepped out on corner entry` remains a Trackside observation, while `I changed rear shock oil from 30 wt to 35 wt` may become a proposed Setup change. Handling observations never trigger inferred tuning changes.

When transcription or extraction is uncertain about a value, axle, block, or other attribution, highlight the exact transcript phrase, leave the structured value unresolved, and ask one focused clarification. Never insert or save a likely value as a best guess.

Confirming explicit setup changes from a Voice draft uses the same `Setup change` workflow as manual tuning edits. Apply all confirmed changes to one copied setup snapshot, preserve the prior setup, make the new snapshot current only after the save succeeds, and retain the originating voice note as provenance. Never patch the historical setup directly.

Retained voice-note provenance includes both the original private audio and its transcript. The transcript or structured draft may be corrected, but the original audio remains unchanged. Keep both until the user explicitly deletes the voice note.

## Production design architecture

Tailwind CSS v4 is the sole visual styling system. Angular provides templates, routing, state, behavior, and accessibility semantics; it does not introduce a second component theme.

1. Define semantic CSS custom properties for canvas, surface, raised control, text, separator, accent, focus, and overlay roles in both light and dark appearances.
2. Expose those semantic properties through Tailwind v4 theme tokens and reusable Tailwind class patterns. Feature templates consume semantic classes rather than raw palette values.
3. Keep the appearance preference as one small signal-based Angular service with `System`, `Light`, and `Dark` states. Apply the resolved appearance at the document root and update it when the operating-system preference changes while `System` is selected.
4. Build controls, fields, status treatments, instrument tables, empty states, overlays, and focus treatments from shared Tailwind patterns. Do not adopt Angular Material visual components.
5. Use `@lucide/angular` as the only icon package and import only icons used by each standalone component.
6. Keep responsive composition in feature templates using the two approved layout modes. Use scoped CSS only for behavior Tailwind cannot express clearly, such as the live microphone meter.
7. Preserve the Commissioner and Fragment Mono role split across every feature.

## Migration sequence

1. Add the semantic light/dark tokens, appearance service, root theme application, font roles, motion timings, radii, and spacing scale.
2. Rebuild the application shell and the combined mobile command bar.
3. Establish the shared Tailwind patterns for controls, fields, focus, overlays, alerts, empty states, and instrument tables.
4. Migrate the selected-car setup readout and voice capture first because they define the mobile visual standard.
5. Migrate the remaining authenticated screens to the same Alloy language without inventing alternate page skins.
6. Remove superseded visual CSS and unused Angular Material packages after confirming there are no remaining consumers.
7. Keep prototype selectors, fake data, decorative chassis graphics, and prototype routes out of production.

## Visual acceptance gates

- Verify light, dark, and system-selected appearance without a flash of the wrong theme.
- Verify layouts at narrow phone, standard phone, large phone, tablet, and desktop widths, with the desktop rail appearing only at `1024px` and above.
- Pass WCAG AA contrast and AXE checks in both appearances.
- Confirm every mobile action has at least a `48px` target and every keyboard-operable control has the approved focus ring.
- Confirm `prefers-reduced-motion` removes spatial and nonessential motion while preserving non-motion live-state feedback.
- Confirm long car names, translated labels, large text, missing values, loading states, and errors do not break the instrument-table alignment.
- Reject any screen that introduces gradients, bright yellow or red, decorative technical imagery, card grids, oversized pills, gratuitous motion, fake data, or mixed iconography.
