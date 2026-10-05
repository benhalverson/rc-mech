import { Hono } from 'hono';
import type { AppEnv } from '../../types';
import { raceRecordingPlaybackResponse } from '../race-recording/race-recording-playback';
import {
	ClipAuthorityError,
	CornerClipAuthority,
} from './corner-clip-authority';

export const createCornerClipRoutes = () => {
	const routes = new Hono<AppEnv>();
	routes.onError((error) => {
		if (error instanceof ClipAuthorityError)
			return Response.json(
				{ error: error.code },
				{
					status:
						error.code === 'NOT_FOUND'
							? 404
							: error.code === 'DELETED'
								? 410
								: 409,
					headers: { 'cache-control': 'private, no-store' },
				},
			);
		return Response.json(
			{ error: 'CLIP_UNAVAILABLE' },
			{ status: 503, headers: { 'cache-control': 'private, no-store' } },
		);
	});
	routes.get('/driving-analyses/:analysisId/clips', async (c) => {
		const rows = await new CornerClipAuthority(c.env.DB).list(
			c.get('userId'),
			c.req.param('analysisId'),
		);
		return c.json(
			{
				clips: rows.map(({ clip, publication, segmentId }) => ({
					id: clip.id,
					cornerId: clip.cornerId,
					ordinal: clip.ordinal,
					segmentId,
					status: publication ? 'ready' : 'not-ready',
					inputDigest: clip.inputDigest,
					checksum: publication?.checksum ?? null,
					durationMs: publication?.durationMs ?? null,
					pipelineVersion: 'corner-render.v1',
				})),
			},
			200,
			{ 'cache-control': 'private, no-store' },
		);
	});
	routes.on(
		['GET', 'HEAD'],
		'/driving-analyses/:analysisId/clips/:clipId/content',
		async (c) => {
			const authority = new CornerClipAuthority(c.env.DB);
			const ownerId = c.get('userId');
			const analysisId = c.req.param('analysisId');
			const clipId = c.req.param('clipId');
			const { publication } = await authority.owned(
				ownerId,
				analysisId,
				clipId,
			);
			const object = await c.env.ANALYSIS_MEDIA.head(publication.objectKey);
			if (
				!object ||
				object.size !== publication.byteCount ||
				object.customMetadata?.sha256 !== publication.checksum
			)
				throw new ClipAuthorityError('NOT_READY');
			const metadata = {
				size: object.size,
				contentType: 'video/mp4' as const,
				etag: object.httpEtag,
				uploaded: object.uploaded,
			};
			return raceRecordingPlaybackResponse(
				{
					content: async (_identity, range) => {
						await authority.owned(ownerId, analysisId, clipId);
						const result = await c.env.ANALYSIS_MEDIA.get(
							publication.objectKey,
							{
								...(range ? { range } : {}),
								onlyIf: { etagMatches: object.etag },
							},
						);
						if (!result || !('body' in result))
							throw new ClipAuthorityError('NOT_READY');
						return { ...metadata, body: result.body };
					},
				},
				{ ownerId, recordingId: clipId },
				c.req.raw,
				metadata,
			);
		},
	);
	return routes;
};
