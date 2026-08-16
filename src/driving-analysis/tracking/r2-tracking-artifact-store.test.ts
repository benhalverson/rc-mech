import { describe, expect, test } from 'vitest';
import { MockR2Controller } from '../../testing/hono-fixture';
import {
	R2TrackingArtifactStore,
	TrackingArtifactStoreError,
	trackingArtifactStore,
} from './r2-tracking-artifact-store';

describe('R2TrackingArtifactStore', () => {
	test('reads bounded private bytes and detects a rewritten object', async () => {
		const r2 = new MockR2Controller();
		const store = new R2TrackingArtifactStore(r2.bucket);
		expect(await store.read('missing', 10)).toBeNull();
		r2.seed('tracking-staging/one', 'first');
		const first = await store.read('tracking-staging/one', 10);
		expect(first).toMatchObject({
			key: 'tracking-staging/one',
			byteCount: 5,
		});

		r2.seed('tracking-staging/one', 'second');
		await expect(
			store.read('tracking-staging/one', 10, first?.etag),
		).rejects.toEqual(new TrackingArtifactStoreError('OBJECT_CHANGED'));
		await expect(store.read('tracking-staging/one', 3)).rejects.toEqual(
			new TrackingArtifactStoreError('OBJECT_TOO_LARGE'),
		);
	});

	test('creates immutable accepted bytes once and lists and deletes metadata', async () => {
		const r2 = new MockR2Controller();
		const store = new R2TrackingArtifactStore(r2.bucket);
		const bytes = new TextEncoder().encode('accepted');
		const checksum =
			'31d52b9d3149e59a8f0b4e190710d9d89d0e27885cbc8771c2c6a7e11cd9c9fc';
		expect(
			await store.putIfAbsent('tracking-evidence/one', bytes, checksum),
		).toBe(true);
		expect(
			await store.putIfAbsent(
				'tracking-evidence/one',
				new TextEncoder().encode('different'),
				'9'.repeat(64),
			),
		).toBe(false);
		expect(
			new TextDecoder().decode(
				(await store.read('tracking-evidence/one', 20))?.bytes,
			),
		).toBe('accepted');
		expect(await store.list('tracking-evidence/')).toMatchObject({
			objects: [{ key: 'tracking-evidence/one', byteCount: 8 }],
			cursor: null,
		});
		r2.listTruncated = true;
		r2.listCursor = 'next-page';
		expect((await store.list('tracking-evidence/')).cursor).toBe('next-page');
		r2.listCursor = undefined;
		expect((await store.list('tracking-evidence/')).cursor).toBeNull();
		expect(trackingArtifactStore({ ANALYSIS_MEDIA: r2.bucket })).toBeInstanceOf(
			R2TrackingArtifactStore,
		);
		await store.putIfAbsent('tracking-evidence/empty-checksum', bytes, '');
		await store.delete(['tracking-evidence/one']);
		expect(await store.read('tracking-evidence/one', 20)).toBeNull();
	});
});
