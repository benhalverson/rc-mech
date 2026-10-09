import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OfflineConnectivity } from '../../offline/offline-connectivity';
import { OfflineGarageStorage } from '../../offline/offline-garage-storage';
import { OfflineWorkspaceStore } from '../../offline/offline-workspace-store';
import type {
	PhotoCapture,
	PhotoCaptureOutcome,
	PhotoView,
} from './photo-sync.models';
import { PhotoSyncGateway } from './photo-sync-gateway';
import { PhotoWorkspaceStore } from './photo-workspace-store';

const photo = {
	id: 'op',
	carId: 'car',
	contentType: 'image/jpeg',
	createdAt: 'today',
};
const file = new File(['photo'], 'car.jpg', { type: 'image/jpeg' });
const command = { carId: 'car', file };
const operation: PhotoCapture = {
	operationId: 'op',
	ownerKey: 'owner',
	carId: 'car',
	fileName: 'car.jpg',
	blob: file,
	photo,
	status: 'pending',
};
const photoView = (captures: readonly PhotoCapture[]): PhotoView => ({
	photos: [photo],
	captures,
});
let store: InstanceType<typeof PhotoWorkspaceStore>;
let offline: {
	ownerKey: ReturnType<typeof signal<string>>;
	sessionKey: ReturnType<typeof signal<string>>;
	hasSnapshot: ReturnType<typeof signal<boolean>>;
	networkUnavailable: ReturnType<typeof signal<boolean>>;
	markOffline: ReturnType<typeof vi.fn>;
	markOnline: ReturnType<typeof vi.fn>;
};
let view: PhotoView | null;
let storage: {
	photoView: ReturnType<typeof vi.fn>;
	commitPhoto: ReturnType<typeof vi.fn>;
	recordPhotoOutcome: ReturnType<typeof vi.fn>;
	readyPhotoCaptures: ReturnType<typeof vi.fn>;
	refreshPhotos: ReturnType<typeof vi.fn>;
};
let gateway: {
	apply: ReturnType<typeof vi.fn>;
	metadata: ReturnType<typeof vi.fn>;
};
let connectivity: {
	retryHint: ReturnType<typeof signal<number>>;
	scheduleRetry: ReturnType<typeof vi.fn>;
	markRequestSucceeded: ReturnType<typeof vi.fn>;
};
const settle = async () => {
	for (let i = 0; i < 8; i++) {
		await Promise.resolve();
		TestBed.tick();
	}
};
beforeEach(() => {
	offline = {
		ownerKey: signal('owner'),
		sessionKey: signal('session'),
		hasSnapshot: signal(false),
		networkUnavailable: signal(false),
		markOffline: vi.fn(),
		markOnline: vi.fn(),
	};
	view = photoView([]);
	storage = {
		readyPhotoCaptures: vi.fn(async () => view?.captures ?? []),
		refreshPhotos: vi.fn(async () => view),
		photoView: vi.fn(async () => view),
		commitPhoto: vi.fn(async () => {
			view = photoView([operation]);
			return view;
		}),
		recordPhotoOutcome: vi.fn(async () => {
			view = photoView([]);
			return view;
		}),
	};
	gateway = {
		metadata: vi.fn(() => of([photo])),
		apply: vi.fn(() => of({ operationId: 'op', outcome: 'applied', photo })),
	};
	connectivity = {
		retryHint: signal(0),
		scheduleRetry: vi.fn(),
		markRequestSucceeded: vi.fn(),
	};
	TestBed.configureTestingModule({
		providers: [
			{ provide: OfflineWorkspaceStore, useValue: offline },
			{ provide: OfflineGarageStorage, useValue: storage },
			{ provide: PhotoSyncGateway, useValue: gateway },
			{ provide: OfflineConnectivity, useValue: connectivity },
		],
	});
	store = TestBed.inject(PhotoWorkspaceStore);
	TestBed.tick();
});
afterEach(() => TestBed.resetTestingModule());
it('opens only the active owner, retains before success, and synchronizes stable operations', async () => {
	expect(store.photos()).toEqual([]);
	expect(store.captures()).toEqual([]);
	expect(store.available()).toBe(false);
	offline.hasSnapshot.set(true);
	await settle();
	expect(store.photos()).toEqual([photo]);
	store.mutate({ requestId: 'request', change: command });
	expect(store.outcome().status).toBe('pending');
	await settle();
	expect(store.outcome()).toEqual({
		status: 'succeeded',
		requestId: 'request',
	});
	expect(store.photos()).toEqual([photo]);
	expect(store.captures()).toEqual([]);
	expect(gateway.apply).toHaveBeenCalledWith(operation);
	expect(storage.commitPhoto).toHaveBeenCalledWith(
		command.carId,
		command.file,
		{
			ownerKey: 'owner',
			sessionKey: 'session',
		},
	);
	offline.ownerKey.set('other');
	expect(store.photos()).toEqual([]);
	expect(store.captures()).toEqual([]);
	offline.hasSnapshot.set(false);
	await settle();
	expect(store.outcome().status).toBe('idle');
});
it('keeps pending work after a transport failure and retries on connectivity evidence', async () => {
	view = photoView([operation]);
	gateway.apply.mockReturnValueOnce(
		throwError(() => ({ kind: 'unavailable' })),
	);
	offline.hasSnapshot.set(true);
	await settle();
	expect(store.captures()).toHaveLength(1);
	expect(store.failure()).toContain('saved here');
	expect(connectivity.scheduleRetry).toHaveBeenCalled();
	connectivity.retryHint.update((value) => value + 1);
	await settle();
	expect(store.captures()).toEqual([]);
	expect(store.syncing()).toBe(false);
});
it('reports durable storage failure without claiming retention and handles an absent snapshot', async () => {
	offline.hasSnapshot.set(true);
	await settle();
	storage.commitPhoto.mockRejectedValueOnce(new Error('quota'));
	store.mutate({ requestId: 'bad', change: command });
	await settle();
	expect(store.outcome()).toMatchObject({
		status: 'failed',
		message: expect.stringContaining('not been retained'),
	});
	view = null;
	store.open();
	await settle();
	expect(store.photos()).toEqual([]);
	expect(store.captures()).toEqual([]);
	storage.photoView.mockRejectedValueOnce(new Error('storage'));
	store.open();
	await settle();
	expect(store.failure()).toContain('could not be loaded');
});
it('ignores late responses after owner or session changes and prevents concurrent drain loops', async () => {
	const response = new Subject<PhotoCaptureOutcome>();
	gateway.apply.mockReturnValue(response);
	view = photoView([operation]);
	offline.hasSnapshot.set(true);
	await settle();
	store.synchronize();
	expect(gateway.apply).toHaveBeenCalledTimes(1);
	offline.sessionKey.set('new-session');
	expect(store.photos()).toEqual([]);
	expect(store.captures()).toEqual([]);
	response.next({
		operationId: 'op',
		outcome: 'applied',
		photo,
	});
	response.complete();
	await settle();
	expect(storage.recordPhotoOutcome).not.toHaveBeenCalled();
});
it('ignores a local commit completed after ownership changes', async () => {
	offline.hasSnapshot.set(true);
	await settle();
	let complete: (value: PhotoView) => void = () => {};
	storage.commitPhoto.mockReturnValueOnce(
		new Promise<PhotoView>((resolve) => {
			complete = resolve;
		}),
	);
	store.mutate({ requestId: 'late', change: command });
	offline.ownerKey.set('other');
	offline.hasSnapshot.set(false);
	TestBed.tick();
	complete(photoView([operation]));
	await settle();
	expect(store.outcome().status).toBe('idle');
});
it.each(['open', 'synchronize'] as const)(
	'ignores a %s read resolving after the owner fence changes',
	async (action) => {
		offline.hasSnapshot.set(true);
		await settle();
		let finish: (value: PhotoView | null) => void = () => {};
		storage[
			action === 'open' ? 'photoView' : 'readyPhotoCaptures'
		].mockReturnValueOnce(
			new Promise<PhotoView | null>((resolve) => {
				finish = resolve;
			}),
		);
		store[action]();
		TestBed.tick();
		offline.hasSnapshot.set(false);
		TestBed.tick();
		finish(view);
		await settle();
		expect(store.photos()).toEqual([]);
	},
);
it.each(['open', 'synchronize', 'mutate'] as const)(
	'does not publish a late %s failure into another session',
	async (action) => {
		offline.hasSnapshot.set(true);
		await settle();
		let fail: (error: Error) => void = () => {};
		const pending = new Promise<PhotoView>((_, reject) => {
			fail = reject;
		});
		if (action === 'mutate') {
			storage.commitPhoto.mockReturnValueOnce(pending);
			store.mutate({ requestId: 'late', change: command });
		} else {
			storage[
				action === 'open' ? 'photoView' : 'readyPhotoCaptures'
			].mockReturnValueOnce(pending);
			store[action]();
			TestBed.tick();
		}
		offline.hasSnapshot.set(false);
		TestBed.tick();
		fail(new Error('late'));
		await settle();
		expect(store.failure()).toBe('');
		expect(store.outcome().status).toBe('idle');
	},
);
it('does not expose a database acknowledgement completed after sign-out', async () => {
	offline.hasSnapshot.set(true);
	await settle();
	view = photoView([operation]);
	let complete: (value: PhotoView | null) => void = () => {};
	storage.recordPhotoOutcome.mockReturnValueOnce(
		new Promise<PhotoView | null>((resolve) => {
			complete = resolve;
		}),
	);
	store.synchronize();
	await settle();
	offline.hasSnapshot.set(false);
	TestBed.tick();
	complete(photoView([]));
	await settle();
	expect(store.photos()).toEqual([]);
});

it('retains work after an unclassified transport failure without inventing connectivity evidence', async () => {
	view = photoView([operation]);
	gateway.apply.mockReturnValueOnce(throwError(() => null));
	offline.hasSnapshot.set(true);
	await settle();
	expect(offline.markOffline).not.toHaveBeenCalled();
	expect(store.captures()).toHaveLength(1);
});
it('retains canonical rejected captures while skipping metadata refresh', async () => {
	view = photoView([operation]);
	gateway.apply.mockReturnValueOnce(
		of({ operationId: 'op', outcome: 'rejected', error: 'Archived' }),
	);
	offline.hasSnapshot.set(true);
	await settle();
	expect(gateway.metadata).not.toHaveBeenCalled();
	expect(storage.recordPhotoOutcome).toHaveBeenCalledWith(
		{ operationId: 'op', outcome: 'rejected', error: 'Archived' },
		[],
		{ ownerKey: 'owner', sessionKey: 'session' },
	);
});
it('does not acknowledge until refreshed metadata is durably recorded', async () => {
	const metadata = new Subject<readonly (typeof photo)[]>();
	gateway.metadata.mockReturnValueOnce(metadata);
	view = photoView([operation]);
	offline.hasSnapshot.set(true);
	await settle();
	expect(store.captures()).toHaveLength(1);
	expect(storage.recordPhotoOutcome).not.toHaveBeenCalled();
	offline.hasSnapshot.set(false);
	TestBed.tick();
	metadata.next([photo]);
	await settle();
	expect(storage.recordPhotoOutcome).not.toHaveBeenCalled();
});
it('refreshes canonical metadata after online changes and fences late refreshes', async () => {
	offline.hasSnapshot.set(true);
	await settle();
	store.refresh('op');
	await settle();
	expect(storage.refreshPhotos).toHaveBeenCalledWith([photo], 'op', {
		ownerKey: 'owner',
		sessionKey: 'session',
	});
	gateway.metadata.mockReturnValueOnce(throwError(() => new Error('offline')));
	store.refresh();
	await settle();
	expect(store.failure()).toContain('could not be refreshed');
	const response = new Subject<readonly (typeof photo)[]>();
	gateway.metadata.mockReturnValueOnce(response);
	store.refresh();
	offline.hasSnapshot.set(false);
	TestBed.tick();
	response.next([photo]);
	await settle();
	expect(storage.refreshPhotos).toHaveBeenCalledTimes(1);
});
it('ignores late metadata persistence and refresh failures', async () => {
	offline.hasSnapshot.set(true);
	await settle();
	let complete: (value: PhotoView | null) => void = () => {};
	storage.refreshPhotos.mockReturnValueOnce(
		new Promise<PhotoView | null>((resolve) => {
			complete = resolve;
		}),
	);
	store.refresh();
	await settle();
	offline.hasSnapshot.set(false);
	TestBed.tick();
	complete(view);
	await settle();
	expect(store.photos()).toEqual([]);
	offline.hasSnapshot.set(true);
	await settle();
	const response = new Subject<readonly (typeof photo)[]>();
	gateway.metadata.mockReturnValueOnce(response);
	store.refresh();
	offline.hasSnapshot.set(false);
	TestBed.tick();
	response.error(new Error('late'));
	await settle();
	expect(store.failure()).toBe('');
});
it('keeps a committed view when an earlier hydration resolves late', async () => {
	let finish!: (value: PhotoView) => void;
	storage.photoView.mockReturnValueOnce(
		new Promise<PhotoView>((resolve) => {
			finish = resolve;
		}),
	);
	offline.hasSnapshot.set(true);
	TestBed.tick();
	gateway.apply.mockReturnValue(throwError(() => ({ kind: 'unavailable' })));
	store.mutate({ requestId: 'committed', change: command });
	await settle();
	expect(store.captures()).toHaveLength(1);
	finish(photoView([]));
	await settle();
	expect(store.captures()).toHaveLength(1);
});
it('recovers a failed hydration on reload and does not publish after destruction', async () => {
	storage.photoView.mockRejectedValueOnce(new Error('read failed'));
	offline.hasSnapshot.set(true);
	await settle();
	expect(store.failure()).toContain('could not be loaded');
	expect(store.photos()).toEqual([]);
	expect(store.captures()).toEqual([]);
	store.open();
	await settle();
	expect(store.failure()).toBe('');
	expect(store.photos()).toEqual([photo]);
	let finish!: (value: PhotoView) => void;
	storage.photoView.mockReturnValueOnce(
		new Promise<PhotoView>((resolve) => {
			finish = resolve;
		}),
	);
	store.open();
	TestBed.tick();
	TestBed.resetTestingModule();
	finish(photoView([operation]));
	await Promise.resolve();
	await Promise.resolve();
	expect(store.photos()).toEqual([]);
});
