# Prefer consumable maintenance history for setup work

**Status:** accepted

The setup-focused maintenance workflow records consumable changes—shock fluid, differential fluid, and front or rear tire sets—as dated history rather than requiring the owner to maintain every installed battery, ESC, servo, or other component. Tire changes are recorded per axle set, with separate optional costs for front and rear, so RC Mech can report replacement frequency and spend without pretending to know a universal service interval. This deliberately favors low-effort, useful records over component inventory and automatic reminders; the existing component-lifecycle maintenance model remains outside this workflow.

**Consequences**

- A tire change can affect the front axle, rear axle, or both in one maintenance entry.
- Tire details can be copied from the current setup so logging a change stays quick.
- Fluid entries identify a service area such as front shocks, rear shocks, front differential, rear differential, or custom.
- Reports can answer “when did I last change this?” and “how often and how much am I spending on tires?”
- Automatic due dates and individual tire identity are intentionally not part of this slice.
