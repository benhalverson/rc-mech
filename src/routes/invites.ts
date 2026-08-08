import { and, desc, eq, lte } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db';
import { INVITE_LIFETIME_LIMIT, validateInviteCode } from '../invite-policy';
import { inviteCode } from '../schema';
import type { AppContext, AppEnv } from '../types';

export const createInviteRoutes = () => {
	const routes = new Hono<AppEnv>();

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
	routes.get('/invite-codes', async (c) => {
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
	routes.post('/invite-codes', async (c) => {
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
	routes.post('/invite-codes/:id/revoke', async (c) => {
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

	return routes;
};
