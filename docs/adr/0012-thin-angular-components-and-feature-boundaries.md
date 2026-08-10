---
status: accepted
---

# Keep Angular components thin through explicit feature boundaries

Chassis Notes uses a one-way Angular feature architecture: components own presentation and local interaction, route-provided NgRx Signal Stores own workflow state and reactive command outcomes, focused gateways and capability services own external systems, and pure functions own transformations. This keeps component dependencies visible without moving the same complexity into catch-all services or umbrella stores.

The standard applies to the entire Angular application, while Alloy remains an authenticated-interface visual decision. It is enforced by source-aware architecture checks and migrated route by route so behavior, production compatibility, accessibility, and full test coverage remain intact. The complete rules and contraction criteria are maintained in [Angular feature architecture](../angular-feature-architecture.md).
