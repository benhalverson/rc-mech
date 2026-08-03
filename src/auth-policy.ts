
export type AuthEnvironment = {
	APP_URL?: string;
	ENVIRONMENT?: string;
	OWNER_EMAIL?: string;
	EMAIL_FROM?: string;
	EMAIL?: unknown;
};

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export const configuredOrigin = (appUrl?: string): string | undefined => {
	if (!appUrl) return undefined;
	try {
		return new URL(appUrl).origin;
	} catch {
		return undefined;
	}
};

export const isLocalDevelopment = (env: AuthEnvironment): boolean => {
	if (env.ENVIRONMENT) return env.ENVIRONMENT === "local";
	const hostname = configuredOrigin(env.APP_URL);
	if (!hostname) return false;
	const { hostname: host } = new URL(hostname);
	return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
};

export const hasMagicLinkConfiguration = (env: AuthEnvironment): boolean => Boolean(
	configuredOrigin(env.APP_URL) && env.OWNER_EMAIL && env.EMAIL_FROM,
);

export const hasEmailDelivery = (env: AuthEnvironment): boolean => Boolean(env.EMAIL && env.EMAIL_FROM);

export const isAllowedOrigin = (origin: string | undefined, appUrl?: string): boolean => Boolean(
	origin && configuredOrigin(appUrl) && origin === configuredOrigin(appUrl),
);

export const isConfiguredOwner = (email: string, env: AuthEnvironment): boolean => {
	const ownerEmail = env.OWNER_EMAIL;
	return Boolean(ownerEmail) && normalizeEmail(email) === normalizeEmail(ownerEmail);
};
