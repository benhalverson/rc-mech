import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { from, type Observable, of, Subject, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CarWorkspaceStore } from '../garage/car-sync/car-workspace-store';
import { OfflineConnectivity } from '../offline/offline-connectivity';
import { OfflineGarageStorage } from '../offline/offline-garage-storage';
import { OfflineWorkspaceStore } from '../offline/offline-workspace-store';
import type { VoiceMutationResponse } from './voice.models';
import { VoiceLegacyMigration } from './voice-legacy-migration';
import { VoiceMediaAccess } from './voice-media-access';
import type { VoiceWorkingCopy } from './voice-sync.models';
import {
	voiceCaptureFixture as capture,
	voiceUpdateFixture as update,
} from './voice-sync.testing';
import { VoiceSyncGateway } from './voice-sync-gateway';
import { VoiceWorkspaceStore } from './voice-workspace-store';

const mediaAccess = {
	open: vi.fn(async (): Promise<string | null> => 'blob:original'),
	clear: vi.fn(),
};
const identity = { ownerKey: 'owner', sessionKey: 'session' };
describe('VoiceWorkspaceStore', () => {
	let view: VoiceWorkingCopy;
	let store: InstanceType<typeof VoiceWorkspaceStore>;
	const offline = {
		hasSnapshot: signal(false),
		ownerKey: signal('owner'),
		sessionKey: signal('session'),
		ownerEmail: signal('owner@example.com'),
		networkUnavailable: signal(false),
		markOnline: vi.fn(),
		markOffline: vi.fn(),
	};
	const connectivity = {
		retryHint: signal(0),
		scheduleRetry: vi.fn(),
		markRequestSucceeded: vi.fn(),
	};
	const gateway = {
		upload: vi.fn(() => of({ voiceUpdate: update })),
		process: vi.fn<() => Observable<VoiceMutationResponse>>(() =>
			of({ voiceUpdate: { ...update, status: 'needs-review' as const } }),
		),
		load: vi.fn(() => of([update])),
	};
	const migration = { migrate: vi.fn(async () => {}) };
	const storage = {
		voiceView: vi.fn(async () => view),
		readyVoice: vi.fn(async () =>
			view.captures.filter(
				(c) => c.phase !== 'retained' && c.status !== 'failed',
			),
		),
		keepVoice: vi.fn(async () => {
			view = { ...view, captures: [capture] };
			return view;
		}),
		changeVoice: vi.fn(async (id: string, change: object | 'discard') => {
			view = {
				...view,
				captures:
					change === 'discard'
						? view.captures.filter((c) => c.id !== id)
						: view.captures.map((c) => (c.id === id ? { ...c, ...change } : c)),
			};
			return view;
		}),
		refreshVoice: vi.fn(async () => view),
	};
	const settle = async () => {
		for (let i = 0; i < 30; i++) {
			await Promise.resolve();
			TestBed.tick();
		}
	};
	beforeEach(() => {
		vi.clearAllMocks();
		view = { captures: [], updates: [] };
		offline.hasSnapshot.set(false);
		offline.ownerKey.set('owner');
		offline.sessionKey.set('session');
		offline.networkUnavailable.set(false);
		TestBed.configureTestingModule({
			providers: [
				{ provide: VoiceMediaAccess, useValue: mediaAccess },
				{ provide: OfflineWorkspaceStore, useValue: offline },
				{ provide: OfflineGarageStorage, useValue: storage },
				{ provide: OfflineConnectivity, useValue: connectivity },
				{ provide: VoiceSyncGateway, useValue: gateway },
				{ provide: VoiceLegacyMigration, useValue: migration },
				{
					provide: CarWorkspaceStore,
					useValue: {
						cars: signal([
							{ id: 'car', name: 'Buggy' },
							{ id: 'archived', name: 'Old', archivedAt: 'now' },
						]),
						operations: signal([]),
						driveOperations: signal([]),
					},
				},
			],
		});
		store = TestBed.inject(VoiceWorkspaceStore);
		TestBed.tick();
	});
	afterEach(() => TestBed.resetTestingModule());
	it('opens owner-fenced original media and keeps unavailable metadata visible', async () => {
		expect(store.media()).toEqual({});
		offline.hasSnapshot.set(true);
		await settle();
		store.openOriginal('capture');
		await settle();
		expect(store.media()['capture']).toBe('blob:original');
		mediaAccess.open.mockRejectedValueOnce(new Error('offline'));
		store.openOriginal('uncached');
		await settle();
		expect(store.media()['uncached']).toBeNull();
		let resolve!: (value: string | null) => void;
		mediaAccess.open.mockReturnValueOnce(
			new Promise((value) => {
				resolve = value;
			}),
		);
		store.openOriginal('late');
		offline.ownerKey.set('another');
		resolve('blob:late');
		await settle();
		expect(store.media()['late']).toBeUndefined();
	});

	it('opens only the current owner and retains audio through upload and processing', async () => {
		expect(store.current()).toBeNull();
		expect(store.captures()).toEqual([]);
		expect(store.updates()).toEqual([]);
		expect(store.cars()).toHaveLength(1);
		expect(store.remoteAvailable()).toBe(true);
		view = { captures: [capture], updates: [update] };
		offline.hasSnapshot.set(true);
		await settle();
		expect(migration.migrate).toHaveBeenCalledWith(
			'owner@example.com',
			identity,
		);
		expect(gateway.upload).toHaveBeenCalledOnce();
		expect(gateway.process).toHaveBeenCalledWith('capture');
		expect(store.captures()).toEqual([]);
		expect(store.updates()).toEqual([update]);
		expect(store.current()?.captures[0].phase).toBe('retained');
		expect(offline.markOnline).toHaveBeenCalledTimes(2);
		offline.sessionKey.set('other');
		expect(store.current()).toBeNull();
		offline.hasSnapshot.set(false);
		TestBed.tick();
		expect(store.outcome().status).toBe('idle');
	});
	it('publishes local success before remote acknowledgement and suppresses overlapping drains', async () => {
		offline.hasSnapshot.set(true);
		await settle();
		const upload = new Subject<VoiceMutationResponse>();
		gateway.upload.mockReturnValueOnce(upload);
		store.keep({ capture, requestId: 'save' });
		await settle();
		expect(store.outcome()).toEqual({ status: 'succeeded', requestId: 'save' });
		expect(store.captures()).toHaveLength(1);
		store.synchronize();
		await settle();
		expect(gateway.upload).toHaveBeenCalledOnce();
		upload.next({ voiceUpdate: { ...update, status: 'saved' } });
		upload.complete();
		await settle();
		expect(gateway.process).not.toHaveBeenCalled();
		expect(store.current()?.captures[0].phase).toBe('retained');
	});
	it('shows one pending note while its acknowledged metadata waits for processing', async () => {
		const processing = new Subject<VoiceMutationResponse>();
		gateway.process.mockReturnValueOnce(processing);
		view = {
			captures: [{ ...capture, phase: 'processing' }],
			updates: [update],
		};
		offline.hasSnapshot.set(true);
		await settle();
		expect(store.captures()).toHaveLength(1);
		expect(store.updates()).toEqual([]);
		processing.next({ voiceUpdate: { ...update, status: 'needs-review' } });
		processing.complete();
		await settle();
		expect(store.captures()).toEqual([]);
		expect(store.updates()).toEqual([update]);
	});

	it('resumes a durable processing stage without reuploading original bytes', async () => {
		view = { captures: [{ ...capture, phase: 'processing' }], updates: [] };
		offline.hasSnapshot.set(true);
		await settle();
		expect(gateway.upload).not.toHaveBeenCalled();
		expect(gateway.process).toHaveBeenCalledOnce();
	});
	it('retains canonical rejection and continues independent captures', async () => {
		view = {
			captures: [capture, { ...capture, id: 'other', carId: 'other' }],
			updates: [],
		};
		gateway.upload.mockReturnValueOnce(
			throwError(() => ({
				kind: 'rejected-response',
				status: 422,
				message: 'Context no longer exists.',
			})),
		);
		gateway.upload.mockReturnValueOnce(
			of({
				voiceUpdate: {
					...update,
					id: 'other',
					carId: 'other',
					status: 'needs-review',
				},
			}),
		);
		offline.hasSnapshot.set(true);
		await settle();
		expect(store.captures()[0]).toMatchObject({
			status: 'failed',
			error: 'Context no longer exists.',
		});
		expect(store.current()?.captures[1].phase).toBe('retained');
		store.retry();
		await settle();
		expect(store.captures()).toEqual([]);
	});
	it('treats a failed request as outage evidence and retries from the shared hint', async () => {
		view = { captures: [capture], updates: [] };
		gateway.upload.mockReturnValueOnce(
			throwError(() => ({ kind: 'unavailable' })),
		);
		offline.hasSnapshot.set(true);
		await settle();
		expect(offline.markOffline).toHaveBeenCalledOnce();
		expect(store.captures()).toHaveLength(1);
		expect(connectivity.scheduleRetry).toHaveBeenCalled();
		connectivity.retryHint.update((v) => v + 1);
		await settle();
		expect(store.captures()).toEqual([]);
	});
	it('retains unknown processing failures with an honest needs-attention message', async () => {
		view = { captures: [{ ...capture, phase: 'processing' }], updates: [] };
		gateway.process.mockReturnValueOnce(throwError(() => null));
		offline.hasSnapshot.set(true);
		await settle();
		expect(store.captures()[0].error).toContain('original note remains');
		expect(offline.markOffline).not.toHaveBeenCalled();
	});
	it('fences late upload and processing responses after sign-out', async () => {
		const upload = new Subject<VoiceMutationResponse>();
		gateway.upload.mockReturnValueOnce(upload);
		view = { captures: [capture], updates: [] };
		offline.hasSnapshot.set(true);
		await settle();
		offline.hasSnapshot.set(false);
		TestBed.tick();
		upload.next({ voiceUpdate: update });
		upload.complete();
		await settle();
		expect(storage.changeVoice).not.toHaveBeenCalled();
		expect(store.current()).toBeNull();
	});
	it('reports storage and migration failures without claiming capture success', async () => {
		migration.migrate.mockRejectedValueOnce(new Error('Legacy unavailable'));
		offline.hasSnapshot.set(true);
		await settle();
		expect(store.failure()).toContain('originals have been retained');
		store.open();
		await settle();
		storage.keepVoice.mockRejectedValueOnce(new Error('Full'));
		store.keep({ capture, requestId: 'save' });
		await settle();
		expect(store.outcome()).toMatchObject({
			status: 'failed',
			requestId: 'save',
		});
		storage.readyVoice.mockRejectedValueOnce(new Error('Disk'));
		store.synchronize();
		await settle();
		expect(store.failure()).toContain('could not be read');
	});
	it('discards explicitly and refreshes metadata without replacing capture bytes', async () => {
		view = { captures: [{ ...capture, status: 'failed' }], updates: [update] };
		offline.hasSnapshot.set(true);
		await settle();
		store.discard({ id: 'capture', requestId: 'discard' });
		await settle();
		expect(store.captures()).toEqual([]);
		expect(store.outcome().status).toBe('succeeded');
		store.refresh();
		await settle();
		expect(storage.refreshVoice).toHaveBeenCalledWith([update], identity);
		storage.changeVoice.mockRejectedValueOnce(new Error('Disk'));
		store.discard({ id: 'capture', requestId: 'failure' });
		await settle();
		expect(store.outcome().status).toBe('failed');
		gateway.load.mockReturnValueOnce(throwError(() => new Error('Offline')));
		store.refresh();
		await settle();
		expect(store.failure()).toContain('Remote refresh is unavailable');
		storage.voiceView.mockRejectedValueOnce(new Error('Disk'));
		store.retry();
		await settle();
		expect(store.failure()).toContain('Retry when storage is available');
	});
	it('reports capability state and waits while the server is still processing', async () => {
		expect(store.available()).toBe(false);
		offline.hasSnapshot.set(true);
		await settle();
		expect(store.available()).toBe(true);
		offline.networkUnavailable.set(true);
		expect(store.remoteAvailable()).toBe(false);
		view = { captures: [{ ...capture, phase: 'processing' }], updates: [] };
		gateway.process.mockReturnValueOnce(
			of({ voiceUpdate: { ...update, status: 'processing' } }),
		);
		store.synchronize();
		await settle();
		expect(store.captures()).toHaveLength(1);
		expect(connectivity.scheduleRetry).toHaveBeenCalled();
		store.synchronize();
		await settle();
		expect(store.captures()).toHaveLength(0);
	});
	it.each(['keep', 'discard', 'retry', 'open', 'sync'] as const)(
		'ignores late %s storage completions after sign-out',
		async (kind) => {
			offline.hasSnapshot.set(true);
			await settle();
			let finish!: (value: VoiceWorkingCopy) => void;
			const pending = new Promise<VoiceWorkingCopy>((resolve) => {
				finish = resolve;
			});
			if (kind === 'keep') {
				storage.keepVoice.mockReturnValueOnce(pending);
				store.keep({ capture, requestId: 'late' });
			}
			if (kind === 'discard') {
				storage.changeVoice.mockReturnValueOnce(pending);
				store.discard({ id: 'capture', requestId: 'late' });
			}
			if (kind === 'retry') {
				storage.voiceView.mockReturnValueOnce(pending);
				store.retry();
			}
			if (kind === 'open') {
				migration.migrate.mockImplementationOnce(async () => {
					await pending;
				});
				store.open();
			}
			if (kind === 'sync') {
				storage.readyVoice.mockImplementationOnce(async () => {
					await pending;
					return [capture];
				});
				store.synchronize();
			}
			await settle();
			offline.hasSnapshot.set(false);
			TestBed.tick();
			finish(view);
			await settle();
			expect(store.current()).toBeNull();
			expect(store.outcome().status).toBe('idle');
		},
	);
	it.each(['keep', 'discard', 'retry', 'open', 'sync', 'refresh'] as const)(
		'ignores late %s failures after sign-out',
		async (kind) => {
			offline.hasSnapshot.set(true);
			await settle();
			let reject!: (error: Error) => void;
			const pending = new Promise<VoiceWorkingCopy>((_, fail) => {
				reject = fail;
			});
			if (kind === 'keep') {
				storage.keepVoice.mockReturnValueOnce(pending);
				store.keep({ capture, requestId: 'late' });
			}
			if (kind === 'discard') {
				storage.changeVoice.mockReturnValueOnce(pending);
				store.discard({ id: 'capture', requestId: 'late' });
			}
			if (kind === 'retry') {
				storage.voiceView.mockReturnValueOnce(pending);
				store.retry();
			}
			if (kind === 'open') {
				migration.migrate.mockImplementationOnce(async () => {
					await pending;
				});
				store.open();
			}
			if (kind === 'sync') {
				storage.readyVoice.mockImplementationOnce(async () => {
					await pending;
					return [];
				});
				store.synchronize();
			}
			if (kind === 'refresh') {
				gateway.load.mockReturnValueOnce(from(pending.then(() => [update])));
				store.refresh();
			}
			await settle();
			offline.hasSnapshot.set(false);
			TestBed.tick();
			reject(new Error('Late'));
			await settle();
			expect(store.failure()).toBe('');
			expect(store.outcome().status).toBe('idle');
		},
	);
	it('fences late processing responses and failures after owner changes, then schedules the new owner', async () => {
		offline.hasSnapshot.set(true);
		await settle();
		view = { captures: [{ ...capture, phase: 'processing' }], updates: [] };
		const pending = new Subject<VoiceMutationResponse>();
		gateway.process.mockReturnValueOnce(pending);
		store.synchronize();
		await settle();
		offline.ownerKey.set('other');
		TestBed.tick();
		view = { captures: [], updates: [] };
		pending.next({ voiceUpdate: update });
		pending.complete();
		await settle();
		expect(connectivity.scheduleRetry).toHaveBeenCalled();
		view = { captures: [capture], updates: [] };
		const upload = new Subject<VoiceMutationResponse>();
		gateway.upload.mockReturnValueOnce(upload);
		store.synchronize();
		await settle();
		offline.hasSnapshot.set(false);
		TestBed.tick();
		upload.error({ kind: 'unavailable' });
		await settle();
		expect(offline.markOffline).not.toHaveBeenCalled();
	});
	it('fences refreshed metadata received after session replacement', async () => {
		offline.hasSnapshot.set(true);
		await settle();
		const pending = new Subject<(typeof update)[]>();
		gateway.load.mockReturnValueOnce(pending);
		store.refresh();
		offline.hasSnapshot.set(false);
		TestBed.tick();
		pending.next([update]);
		pending.complete();
		await settle();
		expect(storage.refreshVoice).not.toHaveBeenCalled();
	});
});
