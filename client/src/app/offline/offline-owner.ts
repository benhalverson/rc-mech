import { object, optional, string } from 'zod/mini';

const offlineOwnerSessionSchema = object({
	session: object({ id: string(), expiresAt: string() }),
	user: object({ id: optional(string()), email: string() }),
});

export type OfflineOwner = Readonly<{
	key: string;
	email: string;
	sessionKey: string;
	offlineUntil: string;
}>;

export const offlineOwnerFromSession = (
	response: unknown,
	now = new Date(),
): OfflineOwner | null => {
	const parsed = offlineOwnerSessionSchema.safeParse(response);
	if (!parsed.success) return null;
	const email = parsed.data.user.email.trim();
	if (!email) return null;
	const sessionKey = parsed.data.session.id.trim();
	if (!sessionKey) return null;
	const offlineUntil = new Date(parsed.data.session.expiresAt);
	if (!Number.isFinite(offlineUntil.valueOf()) || offlineUntil <= now)
		return null;
	const id = parsed.data.user.id?.trim();
	return {
		key: id || email.toLowerCase(),
		email,
		sessionKey,
		offlineUntil: offlineUntil.toISOString(),
	};
};
