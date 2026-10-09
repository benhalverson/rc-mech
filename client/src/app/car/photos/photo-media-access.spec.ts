import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { OfflineGarageStorage } from '../../offline/offline-garage-storage';
import { PHOTO_OBJECT_URL, PhotoMediaAccess } from './photo-media-access';
import { PhotoSyncGateway } from './photo-sync-gateway';

describe('PhotoMediaAccess', () => {
	it('retains viewed originals, reuses offline bytes, and revokes every handle', async () => {
		const blob = new Blob(['private']);
		const storage = {
			retainedPhoto: vi.fn().mockResolvedValue(null),
			retainPhoto: vi.fn().mockResolvedValue(undefined),
		};
		const gateway = { original: vi.fn(() => of(blob)) };
		const urls = {
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
		const access = TestBed.inject(PhotoMediaAccess);
		const fence = { ownerKey: 'owner', sessionKey: 'session' };
		expect(await access.open('photo', fence, true)).toBeNull();
		expect(gateway.original).not.toHaveBeenCalled();
		expect(await access.open('photo', fence, false)).toBe('blob:private');
		expect(storage.retainPhoto).toHaveBeenCalledWith('photo', blob, fence);
		storage.retainedPhoto.mockResolvedValue(blob);
		expect(await access.open('photo', fence, true)).toBe('blob:private');
		expect(gateway.original).toHaveBeenCalledTimes(1);
		access.clear();
		expect(urls.revokeObjectURL).toHaveBeenCalledWith('blob:private');
		access.clear();
		expect(urls.revokeObjectURL).toHaveBeenCalledTimes(1);
		const pending = new Subject<Blob>();
		storage.retainedPhoto.mockResolvedValue(null);
		gateway.original.mockReturnValue(pending);
		const late = access.open('photo', fence, false);
		await Promise.resolve();
		access.clear();
		pending.next(blob);
		pending.complete();
		expect(await late).toBeNull();
		TestBed.resetTestingModule();
	});
	it('exposes the browser object URL capability by default', () => {
		TestBed.configureTestingModule({});
		expect(TestBed.inject(PHOTO_OBJECT_URL)).toBe(URL);
		TestBed.resetTestingModule();
	});
});
