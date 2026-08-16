import { expect, test } from 'vitest';
import { MockR2Controller } from '../../testing/hono-fixture';
import {
	preparedTrackViewStore,
	R2PreparedTrackViewStore,
} from './r2-prepared-track-view-store';

test('reads only bounded R2 object metadata and deletes private objects', async () => {
	const r2 = new MockR2Controller();
	const store = new R2PreparedTrackViewStore(r2.bucket);
	expect(await store.head('missing')).toBeNull();

	await r2.bucket.put('prepared/object', 'data', {
		httpMetadata: { contentType: 'video/mp4' },
		customMetadata: { sha256: 'a'.repeat(64) },
	});
	expect(await store.head('prepared/object')).toEqual({
		key: 'prepared/object',
		byteCount: 4,
		checksumSha256: 'a'.repeat(64),
		contentType: 'video/mp4',
		contentEncoding: null,
	});
	await store.delete(['prepared/object']);
	expect(await store.head('prepared/object')).toBeNull();
});

test('fails metadata verification closed when optional R2 metadata is absent', async () => {
	const r2 = new MockR2Controller();
	r2.seed('prepared/object', 'data', {});
	const store = preparedTrackViewStore({ ANALYSIS_MEDIA: r2.bucket });
	expect(await store.head('prepared/object')).toMatchObject({
		checksumSha256: null,
		contentType: null,
		contentEncoding: null,
	});
});
