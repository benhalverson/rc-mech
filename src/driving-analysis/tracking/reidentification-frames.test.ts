import { gzipSync } from 'node:zlib';
import { describe, expect, test, vi } from 'vitest';
import {
	frameManifestFixture,
	preparedDescriptorFixture,
} from '../../testing/prepared-track-view-fixtures';
import { readReidentificationFrames } from './reidentification-frames';

const fixture = async (
	text = JSON.stringify(frameManifestFixture('a'.repeat(64))),
) => {
	const bytes = new Uint8Array(gzipSync(text));
	const checksum = Array.from(
		new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
		(value) => value.toString(16).padStart(2, '0'),
	).join('');
	const object = {
		key: 'manifest',
		version: '1',
		etag: 'etag',
		uploaded: new Date(),
		bytes,
		byteCount: bytes.byteLength,
	};
	const read = vi.fn(async () => object);
	const prepared = {
		...preparedDescriptorFixture('a'.repeat(64)),
		frameManifestByteCount: bytes.byteLength,
		frameManifestChecksumSha256: checksum,
	};
	return { read, prepared, object };
};

describe('verified re-identification frames', () => {
	test('returns exact variable-rate source pairs without assuming contiguous frame indexes', async () => {
		const f = await fixture();
		expect(await readReidentificationFrames(f, 'manifest', f.prepared)).toEqual(
			[
				{ frameIndex: 2, timestampMs: 100 },
				{ frameIndex: 4, timestampMs: 215 },
				{ frameIndex: 7, timestampMs: 333 },
			],
		);
	});
	test('rejects missing, wrong-sized, corrupt, and mismatched manifests', async () => {
		const f = await fixture();
		await expect(
			readReidentificationFrames(
				{ read: async () => null },
				'manifest',
				f.prepared,
			),
		).rejects.toThrow('unavailable');
		await expect(
			readReidentificationFrames(f, 'manifest', {
				...f.prepared,
				frameManifestByteCount: 1,
			}),
		).rejects.toThrow('unavailable');
		await expect(
			readReidentificationFrames(f, 'manifest', {
				...f.prepared,
				frameManifestChecksumSha256: 'b'.repeat(64),
			}),
		).rejects.toThrow('checksum');
		await expect(
			readReidentificationFrames(f, 'manifest', {
				...f.prepared,
				preparedMediaId: 'wrong',
			}),
		).rejects.toThrow('authority');
		await expect(
			readReidentificationFrames(f, 'manifest', {
				...f.prepared,
				decodedFrameCount: 1,
			}),
		).rejects.toThrow('authority');
		await expect(
			readReidentificationFrames(f, 'manifest', {
				...f.prepared,
				frameManifestByteCount: 17 * 1024 * 1024,
			}),
		).rejects.toThrow('read limit');
		const oversized = await fixture(' '.repeat(8 * 1024 * 1024 + 1));
		await expect(
			readReidentificationFrames(oversized, 'manifest', oversized.prepared),
		).rejects.toThrow('decoded limit');
		const invalid = await fixture('{}');
		await expect(
			readReidentificationFrames(invalid, 'manifest', invalid.prepared),
		).rejects.toThrow();
	});
});
