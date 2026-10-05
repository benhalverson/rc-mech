import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../types';
import { DrivingAnalysisAuthorityError } from '../analysis/driving-analysis-authority';
import { MAX_SUBJECT_FRAME_BYTES } from './subject-frame-contracts';
import { subjectFrames } from './subject-frames';

const index = z.coerce.number().int().nonnegative().safe();
export const createSubjectFrameRoutes = () => {
	const routes = new Hono<AppEnv>();
	routes.onError((error) =>
		Response.json(
			{
				error:
					error instanceof DrivingAnalysisAuthorityError
						? error.message
						: 'The verified source frame is unavailable',
			},
			{
				status:
					error instanceof DrivingAnalysisAuthorityError
						? error.code === 'NOT_FOUND'
							? 404
							: error.code === 'INVALID_INPUT'
								? 400
								: 409
						: 503,
				headers: { 'cache-control': 'private, no-store' },
			},
		),
	);
	routes.get('/race-videos/:recordingId/subject-frame', async (c) => {
		const timestamp = index.safeParse(c.req.query('timestampMs'));
		if (!timestamp.success)
			return c.json({ error: 'Choose a valid source timestamp' }, 400);
		const recordingId = c.req.param('recordingId');
		const frame = await subjectFrames(c.env).select(
			c.get('userId'),
			recordingId,
			{ kind: 'timestamp', timestampMs: timestamp.data },
			false,
		);
		return c.json(
			{
				frame: {
					recordingId,
					requestedTimestampMs: timestamp.data,
					frameIndex: frame.frameIndex,
					timestampMs: frame.timestampMs,
					sourceChecksumSha256: frame.sourceChecksumSha256,
					contentUrl: `/api/v1/race-videos/${encodeURIComponent(recordingId)}/subject-frames/${frame.frameIndex}/content?checksum=${frame.sourceChecksumSha256}`,
				},
			},
			200,
			{ 'cache-control': 'private, no-store' },
		);
	});
	routes.get(
		'/race-videos/:recordingId/subject-frames/:frameIndex/content',
		async (c) => {
			const frameIndex = index.safeParse(c.req.param('frameIndex'));
			const checksum = z
				.string()
				.regex(/^[0-9a-f]{64}$/)
				.safeParse(c.req.query('checksum'));
			if (!frameIndex.success || !checksum.success)
				return c.json({ error: 'Choose a verified source frame' }, 400);
			const frame = await subjectFrames(c.env).select(
				c.get('userId'),
				c.req.param('recordingId'),
				{ kind: 'frame', frameIndex: frameIndex.data },
				true,
				checksum.data,
			);
			if (frame.imageBase64 === null)
				throw new Error('SUBJECT_FRAME_IMAGE_UNAVAILABLE');
			const bytes = Uint8Array.from(atob(frame.imageBase64), (character) =>
				character.charCodeAt(0),
			);
			if (
				bytes.byteLength === 0 ||
				bytes.byteLength > MAX_SUBJECT_FRAME_BYTES ||
				bytes[0] !== 0xff ||
				bytes[1] !== 0xd8
			)
				throw new Error('SUBJECT_FRAME_IMAGE_INVALID');
			return new Response(bytes, {
				headers: {
					'content-type': 'image/jpeg',
					'cache-control': 'private, no-store',
					'x-content-type-options': 'nosniff',
				},
			});
		},
	);
	return routes;
};
