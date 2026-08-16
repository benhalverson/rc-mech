import { Hono } from 'hono';
import type { AppDependencies } from '../../app-dependencies';
import {
	RaceRecordingAuthorityError,
	type RaceRecordingIdentity,
} from '../../driving-analysis/race-recording/race-recording-authority';
import {
	createRaceRecordingInputSchema,
	RACE_RECORDING_PART_SIZE,
	raceRecordingPartRequestSchema,
} from '../../driving-analysis/race-recording/race-recording-contracts';
import type { AppEnv } from '../../types';

const errorStatus = (
	code: RaceRecordingAuthorityError['code'],
): 400 | 404 | 409 | 410 | 429 | 503 => {
	switch (code) {
		case 'INVALID_PART':
			return 400;
		case 'NOT_FOUND':
			return 404;
		case 'CONFLICT':
			return 409;
		case 'EXPIRED':
			return 410;
		case 'QUOTA_EXCEEDED':
		case 'RATE_LIMITED':
			return 429;
		case 'STORAGE_UNAVAILABLE':
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
		if (error instanceof RaceRecordingAuthorityError)
			return Response.json(
				{ error: error.message },
				{ status: errorStatus(error.code) },
			);
		throw error;
	}
};

const identity = (
	ownerId: string,
	recordingId: string,
): RaceRecordingIdentity => ({
	ownerId,
	recordingId,
});

export const createRaceRecordingRoutes = (dependencies: AppDependencies) => {
	const routes = new Hono<AppEnv>();

	routes.get('/cars/:carId/race-videos', (c) =>
		handle(
			() =>
				dependencies
					.raceRecordingAuthority(c.env)
					.list(c.get('userId'), c.req.param('carId')),
			(recordings) => Response.json({ raceVideos: recordings }),
		),
	);

	routes.get('/race-videos/:raceVideoId', (c) =>
		handle(
			() =>
				dependencies
					.raceRecordingAuthority(c.env)
					.get(c.get('userId'), c.req.param('raceVideoId')),
			(raceVideo) => Response.json({ raceVideo }),
		),
	);

	routes.post('/cars/:carId/drives/:driveId/race-videos', async (c) => {
		const parsed = createRaceRecordingInputSchema.safeParse(
			await c.req.json().catch(() => undefined),
		);
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		const params = c.req.param();
		return handle(
			() =>
				dependencies.raceRecordingAuthority(c.env).create({
					ownerId: c.get('userId'),
					carId: params.carId,
					driveSessionId: params.driveId,
					input: parsed.data,
				}),
			({ recording, created }) =>
				Response.json(
					{ raceVideo: recording },
					{ status: created ? 201 : 200 },
				),
		);
	});

	routes.put(
		'/race-videos/:raceVideoId/upload-parts/:partNumber',
		async (c) => {
			const contentLength = Number(c.req.header('content-length'));
			const body = c.req.raw.body;
			const parsed = raceRecordingPartRequestSchema.safeParse({
				partNumber: c.req.param('partNumber'),
				transferRequestId: c.req.header('x-transfer-request-id'),
			});
			if (
				!parsed.success ||
				!Number.isInteger(contentLength) ||
				contentLength < 1 ||
				contentLength > RACE_RECORDING_PART_SIZE ||
				!body
			)
				return c.json({ error: 'Invalid Race-recording part request' }, 400);
			return handle(
				async () =>
					dependencies.raceRecordingAuthority(c.env).uploadPart({
						...identity(c.get('userId'), c.req.param('raceVideoId')),
						partNumber: parsed.data.partNumber,
						transferRequestId: parsed.data.transferRequestId,
						body,
						byteCount: contentLength,
					}),
				(recording) => Response.json({ raceVideo: recording }),
			);
		},
	);

	routes.post('/race-videos/:raceVideoId/complete', (c) =>
		handle(
			() =>
				dependencies
					.raceRecordingAuthority(c.env)
					.complete(identity(c.get('userId'), c.req.param('raceVideoId'))),
			(recording) => Response.json({ raceVideo: recording }),
		),
	);

	routes.delete('/race-videos/:raceVideoId', (c) =>
		handle(
			() =>
				dependencies
					.raceRecordingAuthority(c.env)
					.remove(identity(c.get('userId'), c.req.param('raceVideoId'))),
			() => new Response(null, { status: 204 }),
		),
	);

	return routes;
};
