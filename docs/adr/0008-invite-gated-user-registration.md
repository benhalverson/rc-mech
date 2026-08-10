# Use invite-gated registration for isolated user garages

**Status:** accepted

The Chassis Notes Owner is exclusively the app creator and operator; invited people
are normal Users, each with one isolated garage and one normalized email
identity. New registration requires a single-use invite code bound to the
email address used for the 15-minute magic-link window. Each User may create
up to five human-readable, globally unique codes over their lifetime; codes
are consumed or revoked permanently and never replenish. Existing Users keep
the normal magic-link sign-in flow, while abandoned registration attempts
release their code. This controlled-growth model prevents open bot-driven
registration without giving the Owner cross-garage access or requiring a
sharing/tenant model.

The Owner seeds the initial codes through an operator-only CLI command. Users
may create, view, copy, and revoke their own unused codes. Account deletion,
suspension, email changes, and cross-garage administration are explicitly
deferred. Registration and magic-link requests are rate-limited and return
neutral responses so email and invite-code existence cannot be enumerated.
