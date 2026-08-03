import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export const createAuth = (env: Env) => betterAuth({
	database: drizzleAdapter(drizzle(env.DB, { schema }), { provider: "sqlite" }),
	baseURL: env.APP_URL ?? "http://localhost:8787",
	secret: (env as Env & { BETTER_AUTH_SECRET?: string }).BETTER_AUTH_SECRET ?? "local-development-secret-change-me",
	trustedOrigins: [env.APP_URL ?? "http://localhost:8787"],
	session: { expiresIn: 60 * 60 * 24 * 7 },
	user: { modelName: "owner" },
	plugins: [
		passkey({ rpID: new URL(env.APP_URL ?? "http://localhost:8787").hostname, rpName: "RC Mech" }),
		magicLink({ expiresIn: 60 * 15, sendMagicLink: async () => undefined }),
	],
});
