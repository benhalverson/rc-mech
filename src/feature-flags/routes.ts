import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { isConfiguredOwner } from '../auth-policy';
import { db } from '../db';
import { owner } from '../schema';
import type { AppContext, AppEnv } from '../types';
import { drivingAnalysisFlag } from './schema';

const input = z.object({ enabled: z.boolean() }).strict();

const isOwner = async (c: AppContext) => {
	const user = await db(c.env)
		.select({ email: owner.email })
		.from(owner)
		.where(eq(owner.id, c.get('userId')))
		.get();
	return Boolean(user && isConfiguredOwner(user.email, c.env));
};

export const createFeatureFlagRoutes = () => {
	const routes = new Hono<AppEnv>();
	routes.use('/feature-flags/*', async (c, next) => {
		c.header('Cache-Control', 'no-store');
		await next();
	});
	routes.get('/feature-flags/owner', async (c) =>
		c.json({ isOwner: await isOwner(c) }),
	);
	routes.get('/feature-flags/driving-analysis', async (c) => {
		const flag = await db(c.env)
			.select()
			.from(drivingAnalysisFlag)
			.where(eq(drivingAnalysisFlag.id, 1))
			.get();
		return c.json({ enabled: flag?.enabled ?? false });
	});
	routes.put('/feature-flags/driving-analysis', async (c) => {
		if (!(await isOwner(c)))
			return c.json({ error: 'Owner access required' }, 403);
		const parsed = input.safeParse(await c.req.json().catch(() => null));
		if (!parsed.success)
			return c.json({ error: 'A boolean enabled value is required' }, 400);
		await db(c.env)
			.insert(drivingAnalysisFlag)
			.values({ id: 1, enabled: parsed.data.enabled })
			.onConflictDoUpdate({
				target: drivingAnalysisFlag.id,
				set: { enabled: parsed.data.enabled },
			});
		return c.json(parsed.data);
	});
	return routes;
};
