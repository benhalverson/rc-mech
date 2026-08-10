import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
	configs: [] as unknown[],
	magicOptions: [] as unknown[],
	passkeyOptions: [] as unknown[],
	getResult: null as unknown,
	allResult: [] as unknown[],
}));

vi.mock('better-auth', () => ({
	betterAuth: (config: unknown) => {
		state.configs.push(config);
		return { config };
	},
}));
vi.mock('@better-auth/drizzle-adapter', () => ({
	drizzleAdapter: () => ({ adapter: true }),
}));
vi.mock('@better-auth/passkey', () => ({
	passkey: (options: unknown) => {
		state.passkeyOptions.push(options);
		return { id: 'passkey' };
	},
}));
vi.mock('better-auth/plugins', () => ({
	magicLink: (options: unknown) => {
		state.magicOptions.push(options);
		return { id: 'magic-link' };
	},
}));
vi.mock('drizzle-orm/d1', () => ({
	drizzle: () => ({
		select: () => ({
			from: () => ({ where: () => ({ get: async () => state.getResult }) }),
		}),
		update: () => ({
			set: () => ({
				where: () => ({
					returning: () => ({ all: async () => state.allResult }),
				}),
			}),
		}),
	}),
}));

import { createAuth } from './auth';
import { createHonoFixture } from './testing/hono-fixture';

type AuthConfig = {
	databaseHooks: {
		user: {
			create: {
				before(user: { email: string }): Promise<void>;
				after(user: { id: string; email: string }): Promise<void>;
			};
		};
	};
};
type MagicOptions = {
	sendMagicLink(value: { email: string; url: string }): Promise<void>;
	generateToken?: () => Promise<string>;
};
type PasskeyOptions = {
	rpID: string;
	rpName: string;
	origin: string[];
};

beforeEach(() => {
	state.configs.length = 0;
	state.magicOptions.length = 0;
	state.passkeyOptions.length = 0;
	state.getResult = null;
	state.allResult = [];
});

describe('createAuth', () => {
	test('builds local auth defaults and deterministic test tokens', async () => {
		const { env } = createHonoFixture();
		Object.assign(env, { MAGIC_LINK_TEST_TOKEN: 'fixed-token' });

		createAuth(env);

		const magic = state.magicOptions[0] as MagicOptions;
		expect(await magic.generateToken?.()).toBe('fixed-token');
		await expect(
			magic.sendMagicLink({ email: 'user@example.com', url: 'http://local' }),
		).resolves.toBeUndefined();
		expect(state.passkeyOptions).toHaveLength(1);
		expect(state.passkeyOptions[0] as PasskeyOptions).toMatchObject({
			rpID: 'localhost',
			rpName: 'Chassis Notes',
		});
	});

	test('supplies local URL and token defaults when optional overrides are absent', async () => {
		const { env } = createHonoFixture();
		Object.assign(env, { APP_URL: undefined });
		createAuth(env);
		const magic = state.magicOptions[0] as MagicOptions;
		expect(await magic.generateToken?.()).toBe('local-test-token');
	});

	test('requires APP_URL outside local development', () => {
		const { env } = createHonoFixture();
		Object.assign(env, { ENVIRONMENT: 'production', APP_URL: undefined });
		expect(() => createAuth(env)).toThrow(
			'APP_URL must be configured for deployed environments',
		);
	});

	test('requires configured production email delivery', async () => {
		const { env } = createHonoFixture();
		Object.assign(env, {
			ENVIRONMENT: 'production',
			APP_URL: 'https://chassisnotes.com',
			EMAIL_FROM: undefined,
		});
		createAuth(env);
		const magic = state.magicOptions[0] as MagicOptions;
		await expect(
			magic.sendMagicLink({
				email: 'user@example.com',
				url: 'https://chassisnotes.com/sign-in',
			}),
		).rejects.toThrow('Magic-link email delivery is not configured');
	});

	test('sends configured production magic links', async () => {
		const { env } = createHonoFixture();
		const send = vi.fn(async () => ({ messageId: 'message-1' }));
		Object.assign(env, {
			ENVIRONMENT: 'production',
			APP_URL: 'https://chassisnotes.com',
			EMAIL_FROM: 'Chassis Notes <noreply@chassisnotes.com>',
			EMAIL: { send },
		});
		createAuth(env);
		const magic = state.magicOptions[0] as MagicOptions;
		await magic.sendMagicLink({
			email: 'user@example.com',
			url: 'https://chassisnotes.com/sign-in',
		});
		expect(send).toHaveBeenCalledWith({
			from: 'Chassis Notes <noreply@chassisnotes.com>',
			to: 'user@example.com',
			subject: 'Your Chassis Notes sign-in link',
			text: 'Sign in to Chassis Notes using this one-time link:\n\nhttps://chassisnotes.com/sign-in\n\nThis link expires in 15 minutes and can only be used once.',
		});
		expect(state.passkeyOptions[0] as PasskeyOptions).toMatchObject({
			rpID: 'chassisnotes.com',
			rpName: 'Chassis Notes',
		});
	});

	test('allows the configured Owner through invite hooks', async () => {
		const { env } = createHonoFixture();
		Object.assign(env, { OWNER_EMAIL: 'owner@example.com' });
		createAuth(env);
		const hooks = (state.configs[0] as AuthConfig).databaseHooks.user.create;
		await hooks.before({ email: 'OWNER@example.com' });
		await hooks.after({ id: 'owner-1', email: 'owner@example.com' });
	});

	test('requires and redeems exactly one active invite reservation', async () => {
		const { env } = createHonoFixture();
		createAuth(env);
		const hooks = (state.configs[0] as AuthConfig).databaseHooks.user.create;

		state.getResult = { id: 'invite-1' };
		await expect(
			hooks.before({ email: 'user@example.com' }),
		).resolves.toBeUndefined();
		state.getResult = null;
		await expect(hooks.before({ email: 'user@example.com' })).rejects.toThrow(
			'A valid invite reservation is required',
		);

		state.allResult = [{ id: 'invite-1' }];
		await expect(
			hooks.after({ id: 'user-1', email: 'user@example.com' }),
		).resolves.toBeUndefined();
		state.allResult = [];
		await expect(
			hooks.after({ id: 'user-1', email: 'user@example.com' }),
		).rejects.toThrow('A valid invite reservation is required');
	});
});
