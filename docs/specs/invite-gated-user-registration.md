# Invite-gated User registration

## Problem Statement

Chassis Notes currently supports magic-link access for the app creator through a
configured `OWNER_EMAIL`. Other people cannot create their own isolated
Chassis Notes garage, and opening registration would invite bot-driven signups.
The app needs controlled growth without turning the Owner into a cross-garage
administrator or introducing shared garage tenancy.

## Solution

Add invite-gated registration. The Owner seeds initial invite codes through an
operator-only CLI command. A registered User can create up to five
human-readable, globally unique, single-use invite codes over their lifetime
and manage those codes from the app. A prospective User enters an invite code
and email, receives the existing magic link, and gets one isolated garage when
the link is successfully redeemed. Existing Users continue signing in with a
magic link without an invite code.

## User Stories

1. As the Chassis Notes Owner, I want to seed initial invite codes, so that I can control who can begin registration.
2. As the Owner, I want my configured email to remain the creator identity, so that no invited User becomes an application Owner.
3. As a prospective User, I want to enter an invite code and email, so that I can request access without an open public signup.
4. As a prospective User, I want to receive the existing magic link, so that registration uses the familiar verified-email flow.
5. As a prospective User, I want my garage created only after I redeem the magic link, so that an abandoned request does not create an account or garage.
6. As a User, I want one garage tied to my normalized email, so that I cannot accidentally create duplicate garages.
7. As an existing User, I want to sign in with my email without an invite code, so that invite codes are only required for first registration.
8. As a User, I want five lifetime invite-code slots, so that I can invite a small trusted circle.
9. As a User, I want to choose short shareable code text, so that I can communicate an invite without copying a random string.
10. As a User, I want code text to be trimmed and compared case-insensitively, so that ordinary capitalization and surrounding whitespace do not cause confusing failures.
11. As a User, I want code collisions rejected clearly, so that I know when to choose another unique code.
12. As a User, I want to create codes incrementally, so that unused invite capacity remains available until I need it.
13. As a User, I want to view and copy each unused code, so that I can share it with the intended person.
14. As a User, I want to revoke an unused code, so that a code shared with the wrong person can no longer be used.
15. As a User, I want redeemed and revoked codes retained as history, so that consumed lifetime capacity is clear.
16. As a User, I want abandoned or expired registration attempts to release their code, so that an unsuccessful attempt does not waste invite capacity.
17. As a User, I want a code bound to the email used to request its magic link, so that another email cannot use my invitation.
18. As a User, I want a valid code paired with an existing email to remain unused, so that an existing User does not waste an invitation.
19. As a User, I want registration and magic-link responses to be neutral, so that email and code existence cannot be enumerated.
20. As a User, I want registration and magic-link requests rate-limited, so that automated guessing and abuse are constrained.
21. As a User, I want my new garage to start empty with default UTC timezone, so that registration is quick and settings can be completed later.
22. As a User, I want my cars, setups, photos, maintenance history, and settings isolated from other Users, so that my garage remains private.
23. As a User, I want accessible sign-in and registration controls, so that I can complete the flow with keyboard and assistive technology.
24. As the Owner, I want no cross-garage browsing or modification, so that application ownership does not become an invitation to inspect private User data.

## Implementation Decisions

- Keep Better Auth and the existing magic-link delivery path. Add a distinct registration mode while preserving normal sign-in for existing Users.
- Treat the configured `OWNER_EMAIL` as the creator/operator identity, not as a production allowlist for all authentication requests.
- Add persistent invite-code state sufficient to track creator User, normalized code, lifecycle status, registration email binding, reservation expiry, creation, redemption, and revocation.
- Enforce one User per normalized email by trimming and lowercasing email addresses.
- Require invite codes to be 6–32 characters using letters, numbers, and hyphens. Compare code text case-insensitively after trimming; reject unsafe punctuation, whitespace, reserved values, and global collisions.
- A User may create at most five codes across their lifetime. Codes are created on demand, are single-use, and do not replenish after redemption or revocation.
- The Owner can seed initial codes with an operator-only CLI command. Users can create, view, copy, and revoke their own unused codes through the authenticated app.
- Bind a code to the normalized email at registration request. Reserve it only for the 15-minute magic-link window, release it after expiry, and consume it atomically after successful first-time redemption.
- Existing User email sign-in does not require an invite code and does not consume one.
- Return neutral responses for unknown emails, invalid codes, already-registered emails, and related registration checks where revealing state would enable enumeration.
- Rate-limit registration, code validation, and magic-link requests.
- Create a new User with an empty isolated garage and UTC timezone defaults after successful magic-link registration.
- Preserve owner-scoped record and photo authorization for all existing garage features; do not add shared garages, User-to-User collaboration, or cross-garage Owner administration.
- Defer account deletion, User suspension, email changes, and cross-garage administration.
- Keep the Worker, D1/Drizzle, Cloudflare Email Service, Angular client, same-origin API, and accepted authentication/deployment decisions intact.

## Testing Decisions

- Prefer external behavior at the highest available seams: Worker request/response behavior, rendered Angular access and invite-management behavior, and the existing authenticated browser smoke flow.
- Backend tests must cover valid and invalid code creation, normalization, uniqueness, five-code lifetime limits, reservation expiry, binding, atomic redemption, revocation, existing-User sign-in, neutral responses, rate limiting, and garage isolation.
- Angular tests must cover sign-in versus registration mode, validation and status messaging, accessible controls, code creation/copy/revoke behavior, remaining allowance, and error states.
- Browser acceptance must cover Owner-seeded code, new User registration by magic link, isolated empty garage, five-code allowance, a second registration using a User-created code, reuse rejection, and existing User sign-in without a code.
- Preserve current policy-test patterns and existing Angular component-test patterns; add Worker request-level coverage where route behavior is currently untested.
- Run the repository's standard lint, format, typecheck, backend, client, Worker dry-run, and diff checks.

## Out of Scope

- Open public registration without an invite code.
- Shared garages, organizations, teams, roles beyond the Owner/User distinction, or User collaboration.
- Cross-garage Owner dashboards or private User-data access.
- Account deletion, User suspension, email changes, or ownership transfer.
- Replenishing invite allowances, automatic invite expiry beyond the registration reservation, or random code generation as the User-facing code.
- Passkey registration changes beyond preserving passkeys after magic-link registration.
- Maintenance, setup, photo, or garage-domain feature changes unrelated to authorization isolation.

## Further Notes

The accepted decision is recorded in ADR 0008 and the vocabulary is recorded
in `CONTEXT.md`. The feature should be delivered as dependency-ordered
vertical slices rather than as separate schema/API/UI layers.
