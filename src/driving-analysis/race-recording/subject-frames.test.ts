import { expect, test, vi } from 'vitest';
import { MockD1Controller } from '../../testing/hono-fixture';
import type { SourceFrameResult } from './subject-frame-contracts';
import { SubjectFrames } from './subject-frames';

const row = {
	objectKey:
		'race-recordings/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333',
	byteCount: 4,
	checksumSha256: 'a'.repeat(64),
	status: 'validating',
	validationStatus: 'ready',
	decodedFrameCount: 10,
	durationMs: 1000,
};
const result: SourceFrameResult = {
	contractVersion: 'source-frame.v1',
	frameIndex: 2,
	timestampMs: 200,
	sourceChecksumSha256: 'a'.repeat(64),
	imageBase64: null,
};
test.each([
	'status',
	'validationStatus',
	'byteCount',
	'checksumSha256',
	'decodedFrameCount',
	'durationMs',
])('rejects unavailable source metadata: %s', async (field) => {
	const database = new MockD1Controller();
	database.queue({
		kind: 'first',
		value: {
			...row,
			[field]:
				field.endsWith('Status') || field === 'status' ? 'pending' : null,
		},
	});
	const media = vi.fn(async () => result);
	await expect(
		new SubjectFrames(database.database, media).select(
			'owner',
			'recording',
			{ kind: 'timestamp', timestampMs: 125 },
			false,
		),
	).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
	expect(media).not.toHaveBeenCalled();
});
test.each([
	'checksum',
	'frame-limit',
	'time-limit',
	'wrong-frame',
	'earlier-time',
	'image-missing',
	'changed-key',
	'changed-checksum',
	'changed-bytes',
])('rejects incorrect or changed frame provenance: %s', async (failure) => {
	const database = new MockD1Controller();
	database.queue({ kind: 'first', value: row });
	const response = { ...result };
	if (failure === 'checksum') response.sourceChecksumSha256 = 'b'.repeat(64);
	if (failure === 'frame-limit') response.frameIndex = 10;
	if (failure === 'time-limit') response.timestampMs = 1000;
	if (failure === 'wrong-frame') response.frameIndex = 3;
	if (failure === 'earlier-time') response.timestampMs = 100;
	if (failure.startsWith('changed'))
		database.queue({
			kind: 'first',
			value: {
				...row,
				...(failure === 'changed-key'
					? { objectKey: 'other' }
					: failure === 'changed-checksum'
						? { checksumSha256: 'b'.repeat(64) }
						: { byteCount: 8 }),
			},
		});
	await expect(
		new SubjectFrames(database.database, async () => response).select(
			'owner',
			'recording',
			failure === 'earlier-time'
				? { kind: 'timestamp', timestampMs: 125 }
				: { kind: 'frame', frameIndex: 2 },
			failure === 'image-missing',
		),
	).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
});
test.each(['checksum', 'frame', 'timestamp'])(
	'rejects requested %s outside source authority before decoding',
	async (failure) => {
		const database = new MockD1Controller();
		database.queue({ kind: 'first', value: row });
		const media = vi.fn(async () => result);
		await expect(
			new SubjectFrames(database.database, media).select(
				'owner',
				'recording',
				failure === 'timestamp'
					? { kind: 'timestamp', timestampMs: 1000 }
					: { kind: 'frame', frameIndex: 10 },
				false,
				failure === 'checksum' ? 'b'.repeat(64) : undefined,
			),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' });
		expect(media).not.toHaveBeenCalled();
	},
);
