import { expect, test, vi } from 'vitest';
import { MockR2Controller } from '../../testing/hono-fixture';
import type {
	SourceFrameCommand,
	SourceFrameResult,
} from './subject-frame-contracts';
import {
	type SubjectFrameRuntime,
	selectSubjectFrame,
} from './subject-frame-media';

test('verifies a scoped source and returns actual frame facts without publishing an asset', async () => {
	const r2 = new MockR2Controller();
	const source = {
		objectKey: `race-recordings/${'11111111-1111-4111-8111-111111111111'}/${'22222222-2222-4222-8222-222222222222'}/${'33333333-3333-4333-8333-333333333333'}`,
		byteCount: 4,
		checksumSha256: 'a'.repeat(64),
	};
	r2.seed(source.objectKey, new Uint8Array(4));
	const result = {
		contractVersion: 'source-frame.v1',
		frameIndex: 2,
		timestampMs: 200,
		sourceChecksumSha256: source.checksumSha256,
		imageBase64: null,
	};
	const cleanup = vi.fn(async () => undefined);
	const value = await selectSubjectFrame(
		{
			source,
			selection: { kind: 'timestamp', timestampMs: 125 },
			includeImage: false,
		},
		{
			bucket: r2.bucket,
			start: async () => undefined,
			stage: async () => 0,
			checksum: async () => source.checksumSha256,
			select: async () => Response.json(result),
			cleanup,
		},
	);
	expect(value).toEqual(result);
	expect(cleanup).toHaveBeenCalledOnce();
});

test.each([
	'missing',
	'size',
	'stage',
	'checksum',
	'status',
	'body',
	'type',
	'source',
	'index',
	'timestamp',
	'image',
])('rejects unsafe frame extraction: %s', async (failure) => {
	const r2 = new MockR2Controller();
	const command: SourceFrameCommand = {
		source: {
			objectKey:
				'race-recordings/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333',
			byteCount: 4,
			checksumSha256: 'a'.repeat(64),
		},
		selection:
			failure === 'timestamp'
				? { kind: 'timestamp', timestampMs: 125 }
				: { kind: 'frame', frameIndex: 2 },
		includeImage: false,
	};
	if (failure !== 'missing')
		r2.seed(
			command.source.objectKey,
			new Uint8Array(failure === 'size' ? 3 : 4),
		);
	const result: SourceFrameResult = {
		contractVersion: 'source-frame.v1',
		frameIndex: failure === 'index' ? 3 : 2,
		timestampMs: failure === 'timestamp' ? 100 : 200,
		sourceChecksumSha256:
			failure === 'source' ? 'b'.repeat(64) : command.source.checksumSha256,
		imageBase64: failure === 'image' ? '/9j/2Q==' : null,
	};
	const runtime: SubjectFrameRuntime = {
		bucket: r2.bucket,
		start: async () => undefined,
		stage: async () => (failure === 'stage' ? 1 : 0),
		checksum: async () =>
			failure === 'checksum' ? 'b'.repeat(64) : command.source.checksumSha256,
		select: async () =>
			failure === 'status'
				? new Response('{}', { status: 503 })
				: failure === 'body'
					? new Response(null)
					: failure === 'type'
						? new Response('{}')
						: Response.json(result),
		cleanup: vi.fn(async () => undefined),
	};
	await expect(selectSubjectFrame(command, runtime)).rejects.toThrow();
});
