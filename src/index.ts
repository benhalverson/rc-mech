import { Scalar } from '@scalar/hono-api-reference';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
	type AppDependencies,
	defaultAppDependencies,
} from './app-dependencies';
import { isAllowedOrigin } from './auth-policy';
import { createTrackMapRoutes } from './driving-analysis/track-maps/track-map-routes';
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
export {
	GpuLeaseCoordinator,
	getGpuLeaseCoordinator,
} from './driving-analysis/gpu-lease-coordinator';
export { DrivingAnalysisWorkflow } from './driving-analysis/tracking/driving-analysis-workflow';
export {
	preparedTrackViewStore,
	R2PreparedTrackViewStore,
} from './driving-analysis/tracking/r2-prepared-track-view-store';
export { TrackViewPreparation } from './driving-analysis/tracking/track-view-preparation';

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
		Scalar({ url: '/api/openapi.json', pageTitle: 'Chassis Notes API' }),
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
	app.route('/api/v1', createMaintenanceRoutes(dependencies));
	app.route('/api/v1', createVoiceRoutes(dependencies));
	app.route('/api/v1', createTrackMapRoutes());

	app.all('/api', (c) => c.json({ error: 'Not found' }, 404));
	app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
	app.all('*', spaFallback);
	return app;
};

export const createWorker = (
	dependencies: AppDependencies = defaultAppDependencies,
) => {
	const app = createApp(dependencies);
	return Object.assign(app, {
		scheduled(
			_controller: ScheduledController,
			env: Env,
			context: ExecutionContext,
		): void {
			context.waitUntil(
				dependencies
					.raceRecordingAuthority(env)
					.recoverStale(100)
					.then(() => undefined),
			);
		},
	});
};

const app = createWorker();

export default app;
