import { describe, expect, test, vi } from 'vitest';
import accepted from '../../../containers/driving-analysis/tests/fixtures/corner-render/accepted.json';
import requestFixture from '../../../containers/driving-analysis/tests/fixtures/corner-render/request.json';
import { MockR2Controller } from '../../testing/hono-fixture';
import {
	clipRenderDigest,
	clipRequestSchema,
	clipResponseSchema,
} from './corner-clip-contracts';
import {
	type ClipRenderRuntime,
	readClipBytes,
	renderCornerClip,
} from './corner-clip-renderer';

const bytes = new Uint8Array([1, 2, 3, 4]);
const sourceKey = `race-recordings/${requestFixture.renderId}/${requestFixture.renderId}/${requestFixture.renderId}`;
const command = () => ({
	request: clipRequestSchema.parse(requestFixture),
	sourceObjectKey: sourceKey,
	outputObjectKey: `corner-clips/run-1/${'a'.repeat(64)}.mp4`,
});
const fixture = () => {
	const r2 = new MockR2Controller();
	r2.seed(sourceKey, bytes);
	const runtime: {
		-readonly [K in keyof ClipRenderRuntime]: ClipRenderRuntime[K];
	} = {
		bucket: r2.bucket,
		start: vi.fn(async () => undefined),
		stage: vi.fn(async () => 0),
		checksum: vi.fn(
			async () => requestFixture.specification.sourceChecksumSha256,
		),
		render: vi.fn(async () => Response.json(accepted)),
		stream: vi.fn(async () => ({
			body: new Blob([bytes]).stream(),
			waitForExit: async () => 0,
		})),
		cleanup: vi.fn(async () => undefined),
	};
	return { runtime, r2 };
};

describe('Corner renderer boundary', () => {
	test('shares strict Python contracts and canonical digest', async () => {
		expect(clipResponseSchema.parse(accepted).outcome).toBe('accepted');
		expect(await clipRenderDigest(command().request, '7.1.2')).toBe(
			accepted.artifact.renderInputDigest,
		);
		for (const invalid of [
			{ ...accepted, privateKey: 'no' },
			{ ...accepted, contractVersion: 'v2' },
			{
				...accepted,
				artifact: { ...accepted.artifact, byteCount: 512 * 1024 * 1024 },
			},
			{
				...accepted,
				artifact: { ...accepted.artifact, checksumSha256: 'bad' },
			},
		])
			expect(clipResponseSchema.safeParse(invalid).success).toBe(false);
		const rejected = {
			contractVersion: 'corner-render.v1',
			correlationId: null,
			caseId: null,
			outcome: 'rejected',
			error: {
				code: 'RENDER_FAILED',
				stage: 'render',
				message: 'Corner clip rendering failed safely',
			},
		};
		expect(clipResponseSchema.parse(rejected).outcome).toBe('rejected');
		expect(
			clipResponseSchema.safeParse({
				...rejected,
				error: { ...rejected.error, message: 'https://private-token' },
			}).success,
		).toBe(false);
	});

	test('stages scoped bytes and publishes only verified immutable output', async () => {
		const { runtime, r2 } = fixture();
		await expect(renderCornerClip(command(), runtime)).resolves.toEqual(
			accepted.artifact,
		);
		expect(await r2.bucket.head(command().outputObjectKey)).toMatchObject({
			size: 4,
			customMetadata: { sha256: accepted.artifact.checksumSha256 },
		});
		expect(runtime.render).toHaveBeenCalledOnce();
		expect(runtime.stream).toHaveBeenCalledWith(
			`/var/lib/rc-mech/artifacts/${accepted.artifact.renderId}.corner/${accepted.artifact.renderId}.corner.mp4`,
		);
		expect(runtime.cleanup).toHaveBeenCalledOnce();
	});

	test.each([
		'source-key',
		'output-key',
		'missing-source',
		'source-size',
		'stage',
		'source-checksum',
		'http',
		'empty-response',
		'content-type',
		'rejected',
		'identity',
		'case',
		'artifact-id',
		'artifact-case',
		'artifact-source',
		'bound',
		'digest',
		'stream-exit',
		'stream-size',
		'stream-checksum',
	])('rejects %s without publication', async (failure) => {
		const { runtime, r2 } = fixture();
		const value = command();
		if (failure === 'source-key') value.sourceObjectKey = 'other/private';
		if (failure === 'output-key') value.outputObjectKey = 'other/output';
		if (failure === 'missing-source') await r2.bucket.delete(sourceKey);
		if (failure === 'source-size') value.request.input.expectedByteCount = 10;
		if (failure === 'stage') runtime.stage = async () => 1;
		if (failure === 'source-checksum')
			runtime.checksum = async () => '0'.repeat(64);
		if (failure === 'http')
			runtime.render = async () => new Response('{}', { status: 500 });
		if (failure === 'empty-response')
			runtime.render = async () => new Response(null);
		if (failure === 'content-type')
			runtime.render = async () => new Response('{}');
		if (failure === 'rejected')
			runtime.render = async () =>
				Response.json({
					contractVersion: 'corner-render.v1',
					correlationId: null,
					caseId: null,
					outcome: 'rejected',
					error: {
						code: 'SERVICE_BUSY',
						stage: 'admission',
						message: 'render service is busy',
					},
				});
		const result = structuredClone(accepted);
		if (failure === 'identity') result.correlationId = requestFixture.renderId;
		if (failure === 'case') result.caseId = 'other-run';
		if (failure === 'artifact-id')
			result.artifact.renderId = requestFixture.correlationId;
		if (failure === 'artifact-case') result.artifact.caseId = 'other-run';
		if (failure === 'artifact-source')
			result.artifact.sourceChecksumSha256 = 'b'.repeat(64);
		if (failure === 'bound') value.request.specification.maxOutputBytes = 1;
		if (failure === 'digest')
			result.artifact.renderInputDigest = 'b'.repeat(64);
		if (
			failure.startsWith('artifact') ||
			['identity', 'case', 'digest'].includes(failure)
		)
			runtime.render = async () => Response.json(result);
		if (failure === 'stream-exit')
			runtime.stream = async () => ({
				body: new Blob([bytes]).stream(),
				waitForExit: async () => 1,
			});
		if (failure === 'stream-size')
			runtime.stream = async () => ({
				body: new Blob([bytes.slice(0, 2)]).stream(),
				waitForExit: async () => 0,
			});
		if (failure === 'stream-checksum')
			runtime.stream = async () => ({
				body: new Blob([new Uint8Array(4)]).stream(),
				waitForExit: async () => 0,
			});
		await expect(renderCornerClip(value, runtime)).rejects.toThrow();
		expect(await r2.bucket.head(value.outputObjectKey)).toBeNull();
	});

	test('bounds actual streamed bytes', async () => {
		await expect(readClipBytes(new Blob([bytes]).stream(), 3)).rejects.toThrow(
			'CLIP_OUTPUT_INVALID',
		);
	});

	test.each(['matching', 'missing', 'size', 'checksum', 'digest'])(
		'handles conditional publication collision: %s',
		async (collision) => {
			const { runtime, r2 } = fixture();
			if (collision !== 'missing')
				await r2.bucket.put(
					command().outputObjectKey,
					collision === 'size' ? bytes.slice(0, 2) : bytes,
					{
						customMetadata: {
							sha256:
								collision === 'checksum'
									? 'bad'
									: accepted.artifact.checksumSha256,
							renderInputDigest:
								collision === 'digest'
									? 'bad'
									: accepted.artifact.renderInputDigest,
						},
					},
				);
			runtime.bucket = { ...r2.bucket, put: vi.fn(async () => null) };
			if (collision === 'matching')
				await expect(renderCornerClip(command(), runtime)).resolves.toEqual(
					accepted.artifact,
				);
			else
				await expect(renderCornerClip(command(), runtime)).rejects.toThrow(
					'CLIP_ARTIFACT_CONFLICT',
				);
		},
	);
});
