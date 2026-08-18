import { Hono } from 'hono';
import type { AppDependencies } from '../../app-dependencies';
import { DrivingAnalysisAuthorityError } from '../../driving-analysis/analysis/driving-analysis-authority';
import {
	createDrivingAnalysisInputSchema,
	retryDrivingAnalysisInputSchema,
} from '../../driving-analysis/analysis/driving-analysis-contracts';
import type { AppEnv } from '../../types';

const errorStatus = (
	code: DrivingAnalysisAuthorityError['code'],
): 400 | 404 | 409 | 429 | 503 => {
	switch (code) {
		case 'INVALID_INPUT':
			return 400;
		case 'NOT_FOUND':
			return 404;
		case 'CONFLICT':
		case 'QUOTA_EXCEEDED':
			return 409;
		case 'RATE_LIMITED':
			return 429;
		case 'WORKFLOW_UNAVAILABLE':
			return 503;
	}
};

const handle = async <T>(
	operation: () => Promise<T>,
	onSuccess: (value: T) => Response,
): Promise<Response> => {
	try {
		return onSuccess(await operation());
	} catch (error) {
		if (error instanceof DrivingAnalysisAuthorityError)
			return Response.json(
				{ error: error.message },
				{ status: errorStatus(error.code) },
			);
		throw error;
	}
};

export const createDrivingAnalysisRoutes = (dependencies: AppDependencies) => {
	const routes = new Hono<AppEnv>();

	routes.post('/cars/:carId/drives/:driveId/driving-analyses', async (c) => {
		const parsed = createDrivingAnalysisInputSchema.safeParse(
			await c.req.json().catch(() => undefined),
		);
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		const params = c.req.param();
		return handle(
			() =>
				dependencies.drivingAnalysisAuthority(c.env).create({
					ownerId: c.get('userId'),
					carId: params.carId,
					driveSessionId: params.driveId,
					input: parsed.data,
				}),
			({ analysis }) =>
				Response.json({ drivingAnalysis: analysis }, { status: 202 }),
		);
	});

	routes.get('/driving-analyses/:analysisId', (c) =>
		handle(
			() =>
				dependencies
					.drivingAnalysisAuthority(c.env)
					.get(c.get('userId'), c.req.param('analysisId')),
			(analysis) => Response.json({ drivingAnalysis: analysis }),
		),
	);

	routes.post('/driving-analyses/:analysisId/retry', async (c) => {
		const parsed = retryDrivingAnalysisInputSchema.safeParse(
			await c.req.json().catch(() => undefined),
		);
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		return handle(
			() =>
				dependencies
					.drivingAnalysisAuthority(c.env)
					.retry(
						c.get('userId'),
						c.req.param('analysisId'),
						parsed.data.expectedStateVersion,
					),
			({ analysis }) =>
				Response.json({ drivingAnalysis: analysis }, { status: 202 }),
		);
	});

	return routes;
};
