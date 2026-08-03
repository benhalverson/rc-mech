# Use Better Auth with passkeys and magic-link recovery

**Status:** accepted

Better Auth is the authentication system. Passkeys are the primary sign-in method, while magic links provide first-use bootstrap and account recovery; standard browser WebAuthn QR and cross-device behavior is used instead of maintaining a custom QR protocol. This gives strong phishing-resistant sign-in with a low-friction recovery path while keeping protocol complexity in established libraries and browsers.
