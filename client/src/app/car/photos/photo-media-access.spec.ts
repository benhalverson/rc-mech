import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfflineGarageStorage } from '../../offline/offline-garage-storage';
import { PHOTO_OBJECT_URL, PhotoMediaAccess } from './photo-media-access';
import { PhotoSyncGateway } from './photo-sync-gateway';

const fence = { ownerKey: 'owner', sessionKey: 'session' };
const blob = new Blob(['private']);
const deferred = <T>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((finish) => {
		resolve = finish;
	});
	return { promise, resolve };
};
describe('PhotoMediaAccess', () => {
	let storage: {
		retainedPhoto: ReturnType<typeof vi.fn>;
		retainPhoto: ReturnType<typeof vi.fn>;
	};
	let gateway: { original: ReturnType<typeof vi.fn> };
	let urls: {
		createObjectURL: ReturnType<typeof vi.fn>;
		revokeObjectURL: ReturnType<typeof vi.fn>;
	};
	let access: PhotoMediaAccess;
	beforeEach(() => {
		storage = {
			retainedPhoto: vi.fn().mockResolvedValue(null),
			retainPhoto: vi.fn().mockResolvedValue(undefined),
		};
		gateway = { original: vi.fn(() => of({ blob, revision: 2 })) };
		urls = {
			createObjectURL: vi.fn(() => 'blob:private'),
			revokeObjectURL: vi.fn(),
		};
		TestBed.configureTestingModule({
			providers: [
				{ provide: OfflineGarageStorage, useValue: storage },
				{ provide: PhotoSyncGateway, useValue: gateway },
				{ provide: PHOTO_OBJECT_URL, useValue: urls },
			],
		});
		access = TestBed.inject(PhotoMediaAccess);
	});
	afterEach(() => TestBed.resetTestingModule());
	it('retains online originals and reuses offline bytes without a provider request', async () => {
		const load = new AbortController();
		expect(await access.open('photo', fence, true, load.signal)).toBeNull();
		expect(gateway.original).not.toHaveBeenCalled();
		expect(await access.open('photo', fence, false, load.signal)).toBe(
			'blob:private',
		);
		expect(storage.retainPhoto).toHaveBeenCalledWith('photo', blob, fence, 2);
		storage.retainedPhoto.mockResolvedValue(blob);
		expect(await access.open('photo', fence, true, load.signal)).toBe(
			'blob:private',
		);
		expect(gateway.original).toHaveBeenCalledTimes(1);
		load.abort();
		expect(urls.revokeObjectURL).toHaveBeenCalledTimes(2);
		load.abort();
		expect(urls.revokeObjectURL).toHaveBeenCalledTimes(2);
	});
	it('does not fetch or create a URL when a cached read resolves after cancellation', async () => {
		const read = deferred<Blob | null>();
		storage.retainedPhoto.mockReturnValue(read.promise);
		const load = new AbortController();
		const result = access.open('photo', fence, false, load.signal);
		load.abort();
		read.resolve(null);
		expect(await result).toBeNull();
		expect(gateway.original).not.toHaveBeenCalled();
		expect(urls.createObjectURL).not.toHaveBeenCalled();
	});
	it('does not retain a response cancelled before its continuation runs', async () => {
		const load = new AbortController();
		const result = access.open('photo', fence, false, load.signal);
		await Promise.resolve();
		load.abort();
		expect(await result).toBeNull();
		expect(storage.retainPhoto).not.toHaveBeenCalled();
	});
	it('does not create a URL when cancellation occurs during a fenced cache transaction', async () => {
		const retained = deferred<void>();
		storage.retainPhoto.mockReturnValue(retained.promise);
		const load = new AbortController();
		const result = access.open('photo', fence, false, load.signal);
		await Promise.resolve();
		await Promise.resolve();
		expect(storage.retainPhoto).toHaveBeenCalled();
		load.abort();
		retained.resolve();
		expect(await result).toBeNull();
		expect(urls.createObjectURL).not.toHaveBeenCalled();
	});
	it('cancels an actual HttpClient subscription without retaining partial bytes', async () => {
		TestBed.resetTestingModule();
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				{ provide: OfflineGarageStorage, useValue: storage },
				{ provide: PHOTO_OBJECT_URL, useValue: urls },
			],
		});
		const http = TestBed.inject(HttpTestingController);
		const load = new AbortController();
		const result = TestBed.inject(PhotoMediaAccess).open(
			'photo',
			fence,
			false,
			load.signal,
		);
		await Promise.resolve();
		const request = http.expectOne('/api/v1/photos/photo');
		load.abort();
		expect(request.cancelled).toBe(true);
		expect(await result).toBeNull();
		expect(storage.retainPhoto).not.toHaveBeenCalled();
		http.verify();
	});
	it('exposes the browser object URL capability by default', () => {
		TestBed.resetTestingModule();
		TestBed.configureTestingModule({});
		expect(TestBed.inject(PHOTO_OBJECT_URL)).toBe(URL);
	});
});
