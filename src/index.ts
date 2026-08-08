import { Scalar } from '@scalar/hono-api-reference';
import { and, desc, eq, lte } from 'drizzle-orm';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createAuth } from './auth';
import {
	hasEmailDelivery,
	hasMagicLinkConfiguration,
	isAllowedOrigin,
	isConfiguredOwner,
	isLocalDevelopment,
	normalizeEmail,
} from './auth-policy';
import { db } from './db';
import {
	INVITE_LIFETIME_LIMIT,
	inviteReservationExpiry,
	validateInviteCode,
} from './invite-policy';
import { openApi } from './openapi';
import { createCarsRoutes } from './routes/cars';
import { createMaintenanceRoutes } from './routes/maintenance';
import { createPhotosRoutes } from './routes/photos';
import { createSetupsRoutes } from './routes/setups';
import { authRateLimit, inviteCode, owner } from './schema';
import { AppContext, AppEnv } from './types';

type AuthSession = { user: { id: string } };

export type AppDependencies = {
	getSession(env: Env, headers: Headers): Promise<AuthSession | null>;
	handleAuth(env: Env, request: Request): Promise<Response>;
};

const defaultDependencies: AppDependencies = {
	getSession: async (env, headers) =>
		createAuth(env).api.getSession({ headers }),
	handleAuth: (env, request) => createAuth(env).handler(request),
};

export const createApp = (
	dependencies: AppDependencies = defaultDependencies,
) => {
	const app = new Hono<AppEnv>();

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

	app.use('/api/*', async (c, next) =>
		cors({
			origin: (origin) => (isAllowedOrigin(origin, c.env) ? origin : ''),
			credentials: true,
		})(c, next),
	);

	app.get('/api/openapi.json', (c) => c.json(openApi));
	app.get(
		'/api/docs',
		Scalar({ url: '/api/openapi.json', pageTitle: 'RC Mech API' }),
	);
	app.get('/docs', (c) => c.redirect('/api/docs'));

	app.post('/api/auth/register', async (c) => {
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

	app.on(['GET', 'POST'], '/api/auth/*', async (c) => {
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

	app.use('/api/v1/*', async (c, next) => {
		if (c.req.path === '/api/v1/health') return next();
		const session = await dependencies.getSession(c.env, c.req.raw.headers);
		if (!session) return c.json({ error: 'Authentication required' }, 401);
		c.set('userId', session.user.id);
		return next();
	});

	app.get('/api/v1/health', (c) => c.json({ ok: true, service: 'rc-mech' }));

	const releaseExpiredInvites = async (c: AppContext, creatorId: string) => {
		const now = new Date().toISOString();
		await db(c.env)
			.update(inviteCode)
			.set({
				status: 'available',
				reservedEmail: null,
				reservedUntil: null,
				reservedAt: null,
				updatedAt: now,
			})
			.where(
				and(
					eq(inviteCode.creatorId, creatorId),
					eq(inviteCode.status, 'reserved'),
					lte(inviteCode.reservedUntil, now),
				),
			)
			.run();
	};
	app.get('/api/v1/invite-codes', async (c) => {
		const creatorId = c.get('userId');
		await releaseExpiredInvites(c, creatorId);
		const codes = await db(c.env)
			.select()
			.from(inviteCode)
			.where(eq(inviteCode.creatorId, creatorId))
			.orderBy(desc(inviteCode.createdAt))
			.all();
		return c.json({
			allowance: INVITE_LIFETIME_LIMIT,
			used: codes.length,
			remaining: Math.max(0, INVITE_LIFETIME_LIMIT - codes.length),
			codes,
		});
	});
	app.post('/api/v1/invite-codes', async (c) => {
		const creatorId = c.get('userId');
		await releaseExpiredInvites(c, creatorId);
		const body = (await c.req.json().catch(() => null)) as {
			code?: unknown;
		} | null;
		if (typeof body?.code !== 'string')
			return c.json({ error: 'A code is required' }, 400);
		const parsed = validateInviteCode(body.code);
		if (parsed.ok === false) return c.json({ error: parsed.reason }, 400);
		const now = new Date().toISOString();
		try {
			const database = db(c.env);
			const attemptedIds = [1, 2, 3, 4, 5].map(() => crypto.randomUUID());
			const inserts = [1, 2, 3, 4, 5].map((slot, index) =>
				database
					.insert(inviteCode)
					.values({
						id: attemptedIds[index],
						code: parsed.code,
						creatorId,
						slot,
						status: 'available',
						createdAt: now,
						updatedAt: now,
					})
					.onConflictDoNothing(),
			);
			await database.batch(
				inserts as [(typeof inserts)[number], ...typeof inserts],
			);
			const existing = await database
				.select({ id: inviteCode.id })
				.from(inviteCode)
				.where(eq(inviteCode.code, parsed.code))
				.get();
			if (!existing)
				return c.json({ error: 'Invite-code allowance exhausted' }, 409);
			if (!attemptedIds.includes(existing.id))
				return c.json({ error: 'That invite code is already in use' }, 409);
			const created = await database
				.select()
				.from(inviteCode)
				.where(eq(inviteCode.id, existing.id))
				.get();
			if (!created)
				return c.json({ error: 'Invite-code allowance exhausted' }, 409);
			return c.json({ code: created }, 201);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!/unique constraint failed: invite_code\.code/i.test(message))
				throw error;
			return c.json({ error: 'That invite code is already in use' }, 409);
		}
	});
	app.post('/api/v1/invite-codes/:id/revoke', async (c) => {
		await releaseExpiredInvites(c, c.get('userId'));
		const now = new Date().toISOString();
		const result = await db(c.env)
			.update(inviteCode)
			.set({
				status: 'revoked',
				revokedAt: now,
				reservedEmail: null,
				reservedUntil: null,
				updatedAt: now,
			})
			.where(
				and(
					eq(inviteCode.id, c.req.param('id')),
					eq(inviteCode.creatorId, c.get('userId')),
					eq(inviteCode.status, 'available'),
				),
			)
			.returning()
			.all();
		if (result.length !== 1)
			return c.json(
				{ error: 'Invite code not found or cannot be revoked' },
				404,
			);
		return c.json({ code: result[0] });
	});

	app.route('/api/v1', createCarsRoutes());
	app.route('/api/v1', createSetupsRoutes());
	app.route('/api/v1', createPhotosRoutes());
	app.route('/api/v1', createMaintenanceRoutes());

	app.all('/api', (c) => c.json({ error: 'Not found' }, 404));
	app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

	const hasHiddenPathSegment = (pathname: string): boolean =>
		pathname.split('/').some((segment) => {
			let decoded = segment;
			for (let pass = 0; pass < 2; pass += 1) {
				try {
					const next = decodeURIComponent(decoded);
					if (next === decoded) break;
					decoded = next;
				} catch {
					break;
				}
			}
			return decoded.startsWith('.');
		});

	app.all('*', async (c) => {
		if (hasHiddenPathSegment(new URL(c.req.url).pathname))
			return c.text('Not found', 404);

		const response = await c.env.ASSETS.fetch(c.req.raw);
		if (
			response.status !== 404 ||
			c.req.method !== 'GET' ||
			!c.req.header('Accept')?.includes('text/html')
		)
			return response;
		return c.env.ASSETS.fetch(new Request(new URL('/', c.req.url), c.req.raw));
	});
	return app;
};

const app = createApp();

export default app;
