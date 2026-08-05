# Setup import and consumable maintenance plan

## Outcome

Let an owner paste a So Dialed setup link, review the imported data, and save a complete setup snapshot for an existing or newly created car. Make the next setup cheap to enter by copying the previous setup, while keeping the original PDF as a private reference. Replace the current component-heavy maintenance direction with lightweight history for tires and fluids.

## Scope boundary

In scope:

- Multiple historical setups per car, with an optional current setup.
- Copy-previous setup creation.
- So Dialed link import: paste, fetch, parse, review, then save.
- Source URL, original PDF reference, and unmapped/raw imported values.
- Optional setup context: date, track, event, surface, traction/grip, moisture, condition, and temperature.
- Setup sections for the source sheet's vehicle, track, drivetrain, electronics, tires, shocks, front suspension, rear suspension, and notes.
- Consumable maintenance history for shock fluid, differential fluid, and front/rear tire sets.
- Tire reporting by axle: last change, change frequency, and spend.

Out of scope for this improvement:

- Required entry of batteries, ESCs, servos, or other component inventory.
- Individual tire tracking.
- Automatic maintenance due dates or reminders.
- Direct arbitrary-PDF upload.
- Reproducing the source sheet's diagrams pixel-for-pixel.

## Delivery sequence

The initial delivery slices are tracked in [#34](https://github.com/benhalverson/rc-mech/issues/34), [#35](https://github.com/benhalverson/rc-mech/issues/35), [#36](https://github.com/benhalverson/rc-mech/issues/36), [#37](https://github.com/benhalverson/rc-mech/issues/37), and [#38](https://github.com/benhalverson/rc-mech/issues/38).

### 1. Establish the setup model and source boundary

- Add a setup snapshot owned by a car, with source metadata, optional context, status, and copied-from/reference relationships.
- Define a field catalog that covers every labeled source-sheet area while allowing optional values and an unmapped/raw fallback.
- Keep setup values separate from the existing `Component` lifecycle model.
- Decide the private storage/reference shape for the original PDF within the existing media boundary.

### 2. Build the reviewed import flow

- Accept a So Dialed setup URL and resolve the setup page and linked PDF.
- Extract page metadata and setup-sheet values into a draft; preserve uncertain fields instead of dropping them.
- Let the owner select an existing car or create a car from the source identity, then review and edit the draft.
- Save each accepted import as a new setup snapshot; detect an already imported source and offer that information without overwriting history.

### 3. Make setup editing low effort

- Add setup history and current-setup selection to the car workspace.
- Add “copy previous setup,” defaulting unchanged values from the current or latest setup.
- Group fields by the sheet's recognizable sections and use simple controls for geometry positions and checkbox-like values.
- Show the retained PDF and source link from the setup detail view.

### 4. Reframe maintenance around consumables

- Add maintenance entries for shock fluid, differential fluid, and tire changes.
- Allow fluid service areas such as front shocks, rear shocks, front differential, rear differential, and custom.
- Allow tire changes for front only, rear only, or both; each axle has its own tire details and optional cost.
- Prefill tire details from the car's current setup and keep the recorded change as a historical snapshot.
- Report last change, change intervals, and spend without calculating due dates.

### 5. Verify the operator workflow

- Import the example So Dialed setup and confirm all mapped values are visible, uncertain values are reviewable, and the PDF remains available.
- Import the same link again and confirm no prior setup is overwritten.
- Copy a setup, change only track/condition and selected tuning values, and confirm both snapshots remain distinct.
- Record front-only, rear-only, and full tire changes with separate costs.
- Record front/rear shock and differential fluid changes and confirm history is readable.
- Confirm the existing car/component and maintenance behavior outside this workflow is not broadened unintentionally.

## Decisions still needed during implementation

- Exact schema names and value types for the source sheet's many numeric, text, checkbox, and position fields.
- The extraction mechanism and confidence rules for the So Dialed page/PDF.
- The final current-setup selection behavior when a car has no setup or several equally recent setups.
- The precise report window and wording for tire frequency.
