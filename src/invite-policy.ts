export const INVITE_LIFETIME_LIMIT = 5;
export const INVITE_RESERVATION_MINUTES = 15;
const pattern = /^[A-Z0-9-]{6,32}$/;
const reserved = new Set([
	'ADMIN',
	'API',
	'AUTH',
	'GARAGE',
	'LOGIN',
	'OWNER',
	'REGISTER',
	'ROOT',
	'SETTINGS',
	'SIGN-IN',
	'SYSTEM',
	'USER',
	'WWW',
]);

export const normalizeInviteCode = (value: string): string =>
	value.trim().toUpperCase();
export const validateInviteCode = (
	value: string,
): { ok: true; code: string } | { ok: false; reason: string } => {
	const code = normalizeInviteCode(value);
	if (!pattern.test(code))
		return {
			ok: false,
			reason: 'Invite code must use 6–32 letters, numbers, or hyphens.',
		};
	if (reserved.has(code))
		return { ok: false, reason: 'That invite code is reserved.' };
	return { ok: true, code };
};
export const inviteReservationExpiry = (now = Date.now()): string =>
	new Date(now + INVITE_RESERVATION_MINUTES * 60_000).toISOString();
export const isExpiredReservation = (
	value: string | null | undefined,
	now = Date.now(),
): boolean => Boolean(value && Date.parse(value) <= now);
