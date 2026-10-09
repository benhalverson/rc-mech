import { signal } from '@angular/core';
import { describe, expect, it } from 'vitest';
import {
	type VerifiedFrameImageSource,
	verifiedFrameImage,
} from './verified-frame-image';

describe('verifiedFrameImage', () => {
	it('requires the current exact selection to load, including reused URLs', () => {
		const source = signal<VerifiedFrameImageSource | null>(null);
		const image = verifiedFrameImage(source);
		expect(image.images()).toEqual([]);
		expect(image.ready()).toBe(false);
		expect(image.failed()).toBe(false);
		image.retry();
		expect(image.images()).toEqual([]);
		source.set({ contentUrl: '/frame', identity: 'recording:a:frame:1' });
		const first = image.images()[0];
		if (!first) throw new Error('Missing rendered image');
		expect(image.ready()).toBe(false);
		image.loaded(first);
		expect(image.ready()).toBe(true);
		expect(image.images()[0]).toBe(first);
		// A different checksum/frame must load even when the URL is reused.
		source.set({ contentUrl: '/frame', identity: 'recording:b:frame:2' });
		const second = image.images()[0];
		if (!second) throw new Error('Missing rendered image');
		expect(second).not.toBe(first);
		expect(image.ready()).toBe(false);
		image.loaded(first);
		image.error(first);
		expect(image.ready()).toBe(false);
		expect(image.failed()).toBe(false);
		image.loaded(second);
		expect(image.ready()).toBe(true);
		source.set(null);
		image.error(second);
		image.loaded(second);
		expect(image.images()).toEqual([]);
		expect(image.ready()).toBe(false);
		expect(image.failed()).toBe(false);
	});

	it('recreates a failed image and rejects late events from the previous attempt', () => {
		const source = signal<VerifiedFrameImageSource | null>({
			contentUrl: '/frame',
			identity: 'exact-frame',
		});
		const image = verifiedFrameImage(source);
		const first = image.images()[0];
		if (!first) throw new Error('Missing rendered image');
		image.loaded(first);
		image.error(first);
		expect(image.failed()).toBe(true);
		expect(image.ready()).toBe(false);
		expect(image.images()).toEqual([]);
		image.loaded(first);
		expect(image.failed()).toBe(true);
		image.retry();
		const retried = image.images()[0];
		if (!retried) throw new Error('Missing rendered image');
		expect(retried).not.toBe(first);
		expect(retried.source.contentUrl).toBe(first.source.contentUrl);
		expect(image.failed()).toBe(false);
		expect(image.ready()).toBe(false);
		image.loaded(first);
		image.error(first);
		expect(image.ready()).toBe(false);
		expect(image.failed()).toBe(false);
		image.loaded(retried);
		expect(image.ready()).toBe(true);
		image.retry();
		expect(image.ready()).toBe(false);
	});
});
