import { Scalar } from '@scalar/hono-api-reference';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
	type AppDependencies,
	defaultAppDependencies,
} from './app-dependencies';
import { isAllowedOrigin } from './auth-policy';
import { openApi } from './openapi';
import { createAuthRoutes } from './routes/auth';
import { createCarsRoutes } from './routes/cars';
import { createInviteRoutes } from './routes/invites';
import { createMaintenanceRoutes } from './routes/maintenance';
import { createPhotosRoutes } from './routes/photos';
import { createSetupsRoutes } from './routes/setups';
import { createVoiceRoutes } from './routes/voice';
import { spaFallback } from './spa-fallback';
import type { AppEnv } from './types';

export type { AppDependencies } from './app-dependencies';

export const createApp = (
	dependencies: AppDependencies = defaultAppDependencies,
) => {
	const app = new Hono<AppEnv>();

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
	app.route('/api/auth', createAuthRoutes(dependencies));

	app.use('/api/v1/*', async (c, next) => {
		if (c.req.path === '/api/v1/health') return next();
		const session = await dependencies.getSession(c.env, c.req.raw.headers);
		if (!session) return c.json({ error: 'Authentication required' }, 401);
		c.set('userId', session.user.id);
		return next();
	});

	app.get('/api/v1/health', (c) => c.json({ ok: true, service: 'rc-mech' }));
	app.route('/api/v1', createInviteRoutes());
	app.route('/api/v1', createCarsRoutes());
	app.route('/api/v1', createSetupsRoutes());
	app.route('/api/v1', createPhotosRoutes());
	app.route('/api/v1', createMaintenanceRoutes());
	app.route('/api/v1', createVoiceRoutes(dependencies));

	app.all('/api', (c) => c.json({ error: 'Not found' }, 404));
	app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
	app.all('*', spaFallback);
	return app;
};

const app = createApp();

export default app;
