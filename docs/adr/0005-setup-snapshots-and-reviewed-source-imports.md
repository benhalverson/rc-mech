# Use setup snapshots with reviewed source imports

**Status:** accepted

RC Mech treats a car setup as a historical snapshot rather than as mutable car or component inventory. A new setup is copied from the previous setup, and an external So Dialed link creates a reviewed import draft that is saved as a new snapshot without overwriting earlier history. The imported setup retains its source URL, original PDF reference, and any values that could not be confidently mapped so the structured view remains convenient without becoming the sole source of truth. This favors low-effort track preparation and faithful history over a normalized record of every physical part or exact reproduction of the source sheet's diagrams.

**Consequences**

- A car can have multiple setups for different tracks, surfaces, grip levels, and events.
- Setup context and tuning fields can be optional, so a baseline can be saved quickly and enriched later.
- The import flow needs an owner review step and a durable source reference.
- Diagram-style source values need editable controls or an explicit unmapped state; the PDF remains the visual fallback.
- Component inventory is not required to create or maintain a useful setup.
