import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';
import { magicLink } from 'better-auth/plugins';
import { and, eq, gt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import {
	configuredOrigins,
	isConfiguredOwner,
	isLocalDevelopment,
	normalizeEmail,
} from './auth-policy';
import { createEmailSender } from './email';
import * as schema from './schema';
import { inviteCode } from './schema';

type AuthEnv = Pick<Env, 'DB' | 'EMAIL'> & {
	APP_URL?: string;
	BETTER_AUTH_SECRET?: string;
	EMAIL_FROM?: string;
	OWNER_EMAIL?: string;
	ENVIRONMENT?: string;
	MAGIC_LINK_TEST_TOKEN?: string;
};

const runtimeAppURL = (env: AuthEnv): string => {
	const appURL =
		env.APP_URL ??
		(isLocalDevelopment(env) ? 'http://localhost:8787' : undefined);
	if (!appURL)
		throw new Error('APP_URL must be configured for deployed environments');
	return appURL;
};

export const createAuth = (env: AuthEnv) => {
	const appURL = runtimeAppURL(env);
	const magicLinkOptions = {
		expiresIn: 60 * 15,
		storeToken: 'hashed' as const,
		sendMagicLink: async ({ email, url }: { email: string; url: string }) => {
			if (isLocalDevelopment(env)) return;
			const from = env.EMAIL_FROM;
			const sender = createEmailSender(env);
			if (!from || !sender.available)
				throw new Error('Magic-link email delivery is not configured');
			await sender.send({
				from,
				to: email,
				subject: 'Your Chassis Notes sign-in link',
				text: `Sign in to Chassis Notes using this one-time link:\n\n${url}\n\nThis link expires in 15 minutes and can only be used once.`,
			});
		},
	};
	if (isLocalDevelopment(env)) {
		Object.assign(magicLinkOptions, {
			generateToken: async () =>
				env.MAGIC_LINK_TEST_TOKEN ?? 'local-test-token',
		});
	}
	return betterAuth({
		database: drizzleAdapter(drizzle(env.DB, { schema }), {
			provider: 'sqlite',
		}),
		baseURL: appURL,
		secret: env.BETTER_AUTH_SECRET ?? 'local-development-secret-change-me',
		trustedOrigins: configuredOrigins(appURL, isLocalDevelopment(env)),
		session: { expiresIn: 60 * 60 * 24 * 7 },
		user: { modelName: 'owner' },
		databaseHooks: {
			user: {
				create: {
					before: async (user) => {
						const email = normalizeEmail(user.email);
						if (isConfiguredOwner(email, env)) return;
						const now = new Date().toISOString();
						const reservation = await drizzle(env.DB, { schema })
							.select({ id: inviteCode.id })
							.from(inviteCode)
							.where(
								and(
									eq(inviteCode.status, 'reserved'),
									eq(inviteCode.reservedEmail, email),
									// ISO timestamps sort lexically, so this remains a D1-safe
									// expiry predicate instead of trusting application state.
									gt(inviteCode.reservedUntil, now),
								),
							)
							.get();
						if (!reservation)
							throw new Error('A valid invite reservation is required');
					},
					after: async (user) => {
						const email = normalizeEmail(user.email);
						if (isConfiguredOwner(email, env)) return;
						const now = new Date().toISOString();
						const redeemed = await drizzle(env.DB, { schema })
							.update(inviteCode)
							.set({
								status: 'redeemed',
								redeemedEmail: email,
								redeemedUserId: user.id,
								reservedEmail: null,
								reservedUntil: null,
								redeemedAt: now,
								updatedAt: now,
							})
							.where(
								and(
									eq(inviteCode.status, 'reserved'),
									eq(inviteCode.reservedEmail, email),
									gt(inviteCode.reservedUntil, now),
								),
							)
							.returning({ id: inviteCode.id })
							.all();
						if (redeemed.length !== 1)
							throw new Error('A valid invite reservation is required');
					},
				},
			},
		},
		plugins: [
			passkey({
				rpID: new URL(appURL).hostname,
				rpName: 'Chassis Notes',
				origin: configuredOrigins(appURL, isLocalDevelopment(env)),
				// Discoverable credentials let the browser offer its standard
				// cross-device passkey handoff, including QR where supported.
				authenticatorSelection: {
					residentKey: 'required',
					userVerification: 'preferred',
				},
			}),
			magicLink(magicLinkOptions),
		],
	});
};
