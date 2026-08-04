export type AuthEnvironment = {
	APP_URL?: string;
	ENVIRONMENT?: string;
	OWNER_EMAIL?: string;
	EMAIL_FROM?: string;
	EMAIL?: unknown;
};

export const normalizeEmail = (email: string): string =>
	email.trim().toLowerCase();

export const configuredOrigin = (appUrl?: string): string | undefined => {
	if (!appUrl) return undefined;
	try {
		return new URL(appUrl).origin;
	} catch {
		return undefined;
	}
};

export const configuredOrigins = (
	appUrl: string | undefined,
	local = false,
): string[] => {
	const origin = configuredOrigin(appUrl);
	if (!origin) return [];
	if (!local) return [origin];
	const host = new URL(origin).hostname;
	const devOrigin =
		host === '127.0.0.1'
			? 'http://127.0.0.1:4200'
			: host === 'localhost'
				? 'http://localhost:4200'
				: undefined;
	return devOrigin ? [origin, devOrigin] : [origin];
};

export const isLocalDevelopment = (env: AuthEnvironment): boolean => {
	return env.ENVIRONMENT === 'local';
};

export const hasMagicLinkConfiguration = (env: AuthEnvironment): boolean =>
	Boolean(configuredOrigin(env.APP_URL) && env.OWNER_EMAIL && env.EMAIL_FROM);

export const hasEmailDelivery = (env: AuthEnvironment): boolean =>
	Boolean(env.EMAIL && env.EMAIL_FROM);

export const isAllowedOrigin = (
	origin: string | undefined,
	appUrlOrEnvironment?: string | AuthEnvironment,
): boolean => {
	const environment =
		typeof appUrlOrEnvironment === 'string'
			? { APP_URL: appUrlOrEnvironment }
			: appUrlOrEnvironment;
	return Boolean(
		origin &&
			configuredOrigins(
				environment?.APP_URL,
				isLocalDevelopment(environment ?? {}),
			).includes(origin),
	);
};

export const isConfiguredOwner = (
	email: string,
	env: AuthEnvironment,
): boolean => {
	const ownerEmail = env.OWNER_EMAIL;
	return (
		Boolean(ownerEmail) && normalizeEmail(email) === normalizeEmail(ownerEmail)
	);
};
