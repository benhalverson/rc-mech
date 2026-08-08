import { and, eq, lte } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppDependencies } from '../app-dependencies';
import {
	hasEmailDelivery,
	hasMagicLinkConfiguration,
	isConfiguredOwner,
	isLocalDevelopment,
	normalizeEmail,
} from '../auth-policy';
import { db } from '../db';
import { inviteReservationExpiry, validateInviteCode } from '../invite-policy';
import { authRateLimit, inviteCode, owner } from '../schema';
import type { AppContext, AppEnv } from '../types';

export const createAuthRoutes = (dependencies: AppDependencies) => {
	const routes = new Hono<AppEnv>();

	const neutralAuthResponse = { status: true } as const;
	const authRateLimitResponse = (c: AppContext) =>
		c.json(
			{
				error: 'Too many requests. Please wait a moment and try again.',
				guidance: 'Please wait a moment before requesting another link.',
			},
			429,
			{ 'Retry-After': '60' },
		);
	const authRateLimited = async (
		c: AppContext,
		bucket: string,
	): Promise<boolean> => {
		try {
			const key = `${bucket}:${c.req.header('CF-Connecting-IP') ?? 'unknown'}`;
			const now = Date.now();
			const database = db(c.env);
			const existing = await database
				.select()
				.from(authRateLimit)
				.where(eq(authRateLimit.key, key))
				.get();
			if (!existing || existing.windowStartedAt <= now - 60_000) {
				await database
					.insert(authRateLimit)
					.values({ key, windowStartedAt: now, count: 1 })
					.onConflictDoUpdate({
						target: authRateLimit.key,
						set: { windowStartedAt: now, count: 1 },
					});
				return false;
			}
			const updated = await database
				.update(authRateLimit)
				.set({ count: existing.count + 1 })
				.where(
					and(
						eq(authRateLimit.key, key),
						eq(authRateLimit.windowStartedAt, existing.windowStartedAt),
					),
				)
				.returning({ count: authRateLimit.count })
				.get();
			return (updated?.count ?? existing.count + 1) > 8;
		} catch {
			// A database still completing migration 0014 remains usable; deployed
			// databases persist the bucket once the migration is present.
		}
		return false;
	};

	routes.post('/register', async (c) => {
		if (await authRateLimited(c, 'registration'))
			return authRateLimitResponse(c);
		const body = (await c.req.json().catch(() => null)) as {
			email?: unknown;
			inviteCode?: unknown;
			callbackURL?: unknown;
		} | null;
		if (typeof body?.email !== 'string' || typeof body.inviteCode !== 'string')
			return c.json(neutralAuthResponse);
		const email = normalizeEmail(body.email);
		const code = validateInviteCode(body.inviteCode);
		if (code.ok === false) return c.json(neutralAuthResponse);
		if (
			await db(c.env)
				.select({ id: owner.id })
				.from(owner)
				.where(eq(owner.email, email))
				.get()
		)
			return c.json(neutralAuthResponse);
		const now = new Date().toISOString();
		await db(c.env)
			.update(inviteCode)
			.set({
				status: 'available',
				reservedEmail: null,
				reservedUntil: null,
				updatedAt: now,
			})
			.where(
				and(
					eq(inviteCode.code, code.code),
					eq(inviteCode.status, 'reserved'),
					lte(inviteCode.reservedUntil, now),
				),
			)
			.run();
		const candidate = await db(c.env)
			.select()
			.from(inviteCode)
			.where(
				and(eq(inviteCode.code, code.code), eq(inviteCode.status, 'available')),
			)
			.get();
		if (!candidate) return c.json(neutralAuthResponse);
		const reserved = await db(c.env)
			.update(inviteCode)
			.set({
				status: 'reserved',
				reservedEmail: email,
				reservedUntil: inviteReservationExpiry(),
				reservedAt: now,
				updatedAt: now,
			})
			.where(
				and(
					eq(inviteCode.id, candidate.id),
					eq(inviteCode.status, 'available'),
				),
			)
			.returning({ id: inviteCode.id })
			.all();
		if (reserved.length !== 1) return c.json(neutralAuthResponse);
		const headers = new Headers(c.req.raw.headers);
		headers.set('content-type', 'application/json');
		const target = new URL('/api/auth/sign-in/magic-link', c.req.url);
		try {
			const response = await dependencies.handleAuth(
				c.env,
				new Request(target, {
					method: 'POST',
					body: JSON.stringify({
						email,
						callbackURL: body.callbackURL ?? '/sign-in',
					}),
					headers,
				}),
			);
			if (response.ok) return response;
			await db(c.env)
				.update(inviteCode)
				.set({
					status: 'available',
					reservedEmail: null,
					reservedUntil: null,
					reservedAt: null,
					updatedAt: new Date().toISOString(),
				})
				.where(
					and(
						eq(inviteCode.id, candidate.id),
						eq(inviteCode.status, 'reserved'),
					),
				)
				.run();
			return c.json(neutralAuthResponse);
		} catch {
			await db(c.env)
				.update(inviteCode)
				.set({
					status: 'available',
					reservedEmail: null,
					reservedUntil: null,
					reservedAt: null,
					updatedAt: new Date().toISOString(),
				})
				.where(
					and(
						eq(inviteCode.id, candidate.id),
						eq(inviteCode.status, 'reserved'),
					),
				)
				.run();
			return c.json(neutralAuthResponse);
		}
	});

	routes.on(['GET', 'POST'], '/*', async (c) => {
		if (
			c.req.path === '/api/auth/sign-in/magic-link' &&
			c.req.method === 'POST'
		) {
			const body = (await c.req.raw
				.clone()
				.json()
				.catch(() => null)) as { email?: unknown } | null;
			if (await authRateLimited(c, 'magic-link'))
				return authRateLimitResponse(c);
			if (
				!isLocalDevelopment(c.env) &&
				(!hasMagicLinkConfiguration(c.env) || !hasEmailDelivery(c.env))
			) {
				return c.json({ error: 'Magic-link delivery is unavailable' }, 503);
			}
			if (
				typeof body?.email === 'string' &&
				!(await db(c.env)
					.select({ id: owner.id })
					.from(owner)
					.where(eq(owner.email, normalizeEmail(body.email)))
					.get()) &&
				!isConfiguredOwner(normalizeEmail(body.email), c.env)
			) {
				return c.json({ status: true });
			}
			if (typeof body?.email === 'string') {
				const headers = new Headers(c.req.raw.headers);
				headers.set('content-type', 'application/json');
				return dependencies.handleAuth(
					c.env,
					new Request(c.req.raw, {
						body: JSON.stringify({
							...body,
							email: normalizeEmail(body.email),
						}),
						headers,
					}),
				);
			}
		}
		return dependencies.handleAuth(c.env, c.req.raw);
	});

	return routes;
};
