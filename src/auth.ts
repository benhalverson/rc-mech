import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";
import { createEmailSender } from "./email";
import { configuredOrigin, configuredOrigins, isLocalDevelopment } from "./auth-policy";

type AuthEnv = Env & {
	APP_URL?: string;
	BETTER_AUTH_SECRET?: string;
	EMAIL_FROM?: string;
	OWNER_EMAIL?: string;
	ENVIRONMENT?: string;
	MAGIC_LINK_TEST_TOKEN?: string;
};

const runtimeAppURL = (env: AuthEnv): string => {
	const appURL = env.APP_URL ?? (isLocalDevelopment(env) ? "http://localhost:8787" : undefined);
	if (!appURL) throw new Error("APP_URL must be configured for deployed environments");
	return appURL;
};

export const createAuth = (env: AuthEnv) => {
	const appURL = runtimeAppURL(env);
	const magicLinkOptions = {
		expiresIn: 60 * 15,
		storeToken: "hashed" as const,
		sendMagicLink: async ({ email, url }: { email: string; url: string }) => {
			const from = env.EMAIL_FROM;
			const sender = createEmailSender(env);
			if (!from || !sender.available) {
				if (isLocalDevelopment(env)) return;
				throw new Error("Magic-link email delivery is not configured");
			}
			await sender.send({
				from,
				to: email,
				subject: "Your RC Mech sign-in link",
				text: `Sign in to RC Mech using this one-time link:\n\n${url}\n\nThis link expires in 15 minutes and can only be used once.`,
			});
		},
	};
	if (isLocalDevelopment(env) && env.MAGIC_LINK_TEST_TOKEN) {
		Object.assign(magicLinkOptions, { generateToken: async () => env.MAGIC_LINK_TEST_TOKEN });
	}
	return betterAuth({
	database: drizzleAdapter(drizzle(env.DB, { schema }), { provider: "sqlite" }),
	baseURL: appURL,
	secret: env.BETTER_AUTH_SECRET ?? "local-development-secret-change-me",
	trustedOrigins: configuredOrigins(appURL, isLocalDevelopment(env)),
	session: { expiresIn: 60 * 60 * 24 * 7 },
	user: { modelName: "owner" },
	plugins: [
		passkey({
			rpID: new URL(appURL).hostname,
			rpName: "RC Mech",
			origin: configuredOrigins(appURL, isLocalDevelopment(env)),
			// Discoverable credentials let the browser offer its standard
			// cross-device passkey handoff, including QR where supported.
			authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
		}),
		magicLink(magicLinkOptions),
	],
	});
};
