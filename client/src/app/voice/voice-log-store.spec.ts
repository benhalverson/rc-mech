import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
	type TestRequest,
} from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwnerSessionStore } from '../owner-session-store';
import { VoiceLogStore } from './voice-log-store';
import type {
	PendingVoiceCapture,
	VoiceMutationResponse,
	VoiceUpdate,
} from './voice.models';
import { VoiceOfflineQueue } from './voice-offline-queue';

const emptyDraft = {
	setupChanges: [],
	problems: [],
	conditions: [],
	driveSessionNotes: [],
	consumables: [],
	unmappedNotes: [],
	unresolvedNotes: [],
};

const update = (overrides: Partial<VoiceUpdate> = {}): VoiceUpdate => ({
	id: 'voice-1',
	carId: 'car-1',
	driveSessionId: null,
	status: 'pending',
	contentType: null,
	fileName: null,
	byteSize: 0,
	audioUrl: null,
	transcript: 'Track note',
	draft: emptyDraft,
	corrections: [],
	clarificationPrompt: null,
	error: null,
	confirmedAt: null,
	artifactDeletedAt: null,
	createdAt: '2026-08-08T01:00:00.000Z',
	updatedAt: '2026-08-08T01:00:00.000Z',
	results: [],
	...overrides,
});

const capture = (
	id: string,
	overrides: Partial<PendingVoiceCapture> = {},
): PendingVoiceCapture => ({
	id,
	ownerKey: 'owner@example.test',
	carId: 'car-1',
	driveSessionId: null,
	text: 'Track note',
	contentType: 'text/plain',
	fileName: `${id}.txt`,
	createdAt: '2026-08-08T01:00:00.000Z',
	status: 'local',
	error: null,
	...overrides,
});

class QueueHarness {
	readonly captures = new Map<string, PendingVoiceCapture>();
	failRemove = false;

	async put(value: PendingVoiceCapture): Promise<void> {
		this.captures.set(value.id, value);
	}

	async list(ownerKey: string): Promise<PendingVoiceCapture[]> {
		return [...this.captures.values()].filter(
			(value) => value.ownerKey === ownerKey,
		);
	}

	async updateStatus(
		id: string,
		status: PendingVoiceCapture['status'],
		error: string | null,
	): Promise<void> {
		const value = this.captures.get(id);
		if (value) this.captures.set(id, { ...value, status, error });
	}

	async remove(id: string): Promise<void> {
		if (this.failRemove) {
			this.failRemove = false;
			throw new Error('local database unavailable');
		}
		this.captures.delete(id);
	}
}

describe('VoiceLogStore', () => {
	let http: HttpTestingController | undefined;
	let queue: QueueHarness;
	let uuid = 0;

	const configure = (): InstanceType<typeof VoiceLogStore> => {
		queue = new QueueHarness();
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				VoiceLogStore,
				{ provide: VoiceOfflineQueue, useValue: queue },
				{
					provide: OwnerSessionStore,
					useValue: { ownerEmail: signal(' Owner@Example.Test ') },
				},
			],
		});
		http = TestBed.inject(HttpTestingController);
		return TestBed.inject(VoiceLogStore);
	};

	const selectAndFlush = async (
		store: InstanceType<typeof VoiceLogStore>,
		updates: VoiceUpdate[] = [],
	): Promise<void> => {
		store.selectCar('car-1');
		await vi.waitFor(() => {
			http?.expectOne('/api/v1/cars').flush({
				cars: [
					{ id: 'car-1', name: 'Buggy', archivedAt: null },
					{ id: 'car-2', name: 'Archived', archivedAt: '2026-08-08' },
				],
			});
			http
				?.expectOne('/api/v1/cars/car-1/voice-updates')
				.flush({ voiceUpdates: updates });
		});
		await vi.waitFor(() => expect(store.loading()).toBe(false));
	};

	const flushReloads = (updates: VoiceUpdate[] = []): void => {
		for (const request of http?.match(
			(request) =>
				request.method === 'GET' &&
				request.url === '/api/v1/cars/car-1/voice-updates',
		) ?? [])
			request.flush({ voiceUpdates: updates });
	};

	const expectUpload = (): TestRequest | undefined =>
		http?.expectOne(
			(request) =>
				request.method === 'POST' &&
				request.url === '/api/v1/cars/car-1/voice-updates',
		);

	const completeMutation = async (
		operation: Promise<VoiceMutationResponse | null>,
		method: string,
		url: string,
		response: VoiceMutationResponse = { voiceUpdate: update() },
	): Promise<VoiceMutationResponse | null> => {
		let request: TestRequest | undefined;
		await vi.waitFor(() => {
			request = http?.expectOne(url);
		});
		expect(request?.request.method).toBe(method);
		request?.flush(response);
		const result = await operation;
		flushReloads();
		return result;
	};

	afterEach(() => {
		try {
			flushReloads();
			http?.verify();
		} finally {
			http = undefined;
			vi.unstubAllGlobals();
			vi.restoreAllMocks();
			TestBed.resetTestingModule();
		}
	});

	it('derives owner-scoped reads, active cars, and local captures', async () => {
		const store = configure();
		queue.captures.set('matching', capture('matching'));
		queue.captures.set('other-car', capture('other-car', { carId: 'car-2' }));
		queue.captures.set(
			'other-owner',
			capture('other-owner', { ownerKey: 'someone@example.test' }),
		);
		expect(store.updates()).toEqual([]);
		expect(store.cars()).toEqual([]);
		expect(store.readError()).toBe('');
		await selectAndFlush(store, [update()]);
		store.selectCar('car-1');
		await vi.waitFor(() => expect(store.localCaptures()).toHaveLength(1));
		expect(store.updates()).toHaveLength(1);
		expect(store.cars().map(({ id }) => id)).toEqual(['car-1']);
		store.retryRead();
		await vi.waitFor(() => {
			http
				?.expectOne('/api/v1/cars/car-1/voice-updates')
				.flush({ voiceUpdates: [] });
		});
		store.clearFeedback();
		store.selectCar('');
	});

	it('maps protected and generic voice-history read failures', async () => {
		const store = configure();
		store.selectCar('car-1');
		await vi.waitFor(() => {
			http?.expectOne('/api/v1/cars').flush({ cars: [] });
			http
				?.expectOne('/api/v1/cars/car-1/voice-updates')
				.flush('expired', { status: 401, statusText: 'Unauthorized' });
		});
		await vi.waitFor(() =>
			expect(store.readError()).toContain('session has expired'),
		);

		store.retryRead();
		await vi.waitFor(() => {
			http
				?.expectOne('/api/v1/cars/car-1/voice-updates')
				.flush('offline', { status: 503, statusText: 'Unavailable' });
		});
		await vi.waitFor(() =>
			expect(store.readError()).toContain('could not be loaded'),
		);
	});

	it('uploads audio and text captures and tolerates processing failure', async () => {
		const store = configure();
		await selectAndFlush(store);
		vi.spyOn(crypto, 'randomUUID').mockImplementation(
			() => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
		);

		const audio = store.enqueueAudio(
			new Blob(['voice'], { type: 'audio/mp4' }),
			'drive-1',
		);
		let upload: TestRequest | undefined;
		await vi.waitFor(() => {
			upload = expectUpload();
		});
		expect(upload?.request.body).toBeInstanceOf(FormData);
		upload?.flush({ voiceUpdate: update({ id: 'server-audio' }) });
		await vi.waitFor(() => {
			http
				?.expectOne('/api/v1/voice-updates/server-audio/process')
				.flush({ voiceUpdate: update({ id: 'server-audio' }) });
		});
		await audio;
		flushReloads();
		expect(queue.captures.size).toBe(0);

		const fallbackAudio = store.enqueueAudio(new Blob(['voice']), null);
		await vi.waitFor(() => {
			expectUpload()?.flush({ voiceUpdate: update({ id: 'server-webm' }) });
		});
		await vi.waitFor(() => {
			http
				?.expectOne('/api/v1/voice-updates/server-webm/process')
				.flush('provider failed', { status: 502, statusText: 'Bad Gateway' });
		});
		await fallbackAudio;
		flushReloads();
	});

	it('queues offline text, retries it online, and supports local discard', async () => {
		const store = configure();
		await selectAndFlush(store);
		vi.spyOn(crypto, 'randomUUID').mockReturnValue(
			'00000000-0000-4000-8000-000000000010',
		);
		vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
		await store.enqueueText('Offline track note', null);
		expect(
			queue.captures.get('00000000-0000-4000-8000-000000000010'),
		).toMatchObject({ status: 'queued', error: 'Waiting for a connection.' });
		await store.retryQueued();

		vi.restoreAllMocks();
		vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
		const retry = store.retryQueued();
		await vi.waitFor(() => {
			expectUpload()?.flush({ voiceUpdate: update({ id: 'server-text' }) });
		});
		await vi.waitFor(() => {
			http
				?.expectOne('/api/v1/voice-updates/server-text/process')
				.flush({ voiceUpdate: update({ id: 'server-text' }) });
		});
		await retry;
		flushReloads();

		queue.captures.set('discard-me', capture('discard-me'));
		store.selectCar('car-1');
		await vi.waitFor(() => expect(store.localCaptures()).toHaveLength(1));
		await store.discardLocal('discard-me');
		expect(store.message()).toBe('Pending recording discarded.');
	});

	it('retains failed uploads with actionable HTTP and local errors', async () => {
		const store = configure();
		await selectAndFlush(store);
		const pending = capture('retry-me');
		queue.captures.set(pending.id, pending);

		const conflict = store.retryQueued();
		await vi.waitFor(() => {
			expectUpload()?.flush(
				{ error: 'Capture ID is already in use' },
				{ status: 409, statusText: 'Conflict' },
			);
		});
		await conflict;
		flushReloads();
		expect(queue.captures.get(pending.id)).toMatchObject({
			status: 'failed',
			error: 'Capture ID is already in use',
		});

		const expired = store.retryQueued();
		await vi.waitFor(() => {
			expectUpload()?.flush('expired', {
				status: 401,
				statusText: 'Unauthorized',
			});
		});
		await expired;
		flushReloads();
		expect(queue.captures.get(pending.id)?.error).toContain(
			'session has expired',
		);

		const network = store.retryQueued();
		await vi.waitFor(() => {
			expectUpload()?.error(new ProgressEvent('offline'));
		});
		await network;
		flushReloads();
		expect(queue.captures.get(pending.id)?.status).toBe('queued');

		queue.failRemove = true;
		const localFailure = store.retryQueued();
		await vi.waitFor(() => {
			expectUpload()?.flush({
				voiceUpdate: update({ id: 'server-local-failure' }),
			});
		});
		await localFailure;
		flushReloads();
		expect(queue.captures.get(pending.id)).toMatchObject({ status: 'queued' });
	});

	it('serializes every review mutation and exposes success feedback', async () => {
		const store = configure();
		await selectAndFlush(store);

		const process = store.process('voice/one');
		expect(store.action()).toBe('process:voice/one');
		await expect(store.process('blocked')).resolves.toBeNull();
		await expect(
			completeMutation(
				process,
				'POST',
				'/api/v1/voice-updates/voice%2Fone/process',
			),
		).resolves.toMatchObject({ voiceUpdate: { id: 'voice-1' } });
		expect(store.message()).toBe('');

		await completeMutation(
			store.correctText('voice-1', 'Rear, not front'),
			'POST',
			'/api/v1/voice-updates/voice-1/corrections',
		);
		expect(store.message()).toContain('Draft corrected');

		await completeMutation(
			store.correctAudio('voice-1', new Blob(['fix'], { type: 'audio/webm' })),
			'POST',
			'/api/v1/voice-updates/voice-1/corrections',
		);
		await completeMutation(
			store.correctAudio('voice-1', new Blob(['fix'])),
			'POST',
			'/api/v1/voice-updates/voice-1/corrections',
		);

		await completeMutation(
			store.confirm('voice-1', true),
			'POST',
			'/api/v1/voice-updates/voice-1/confirm',
		);
		expect(store.message()).toContain('saved');

		await completeMutation(
			store.updateContext('voice-1', 'car-2', null),
			'PATCH',
			'/api/v1/voice-updates/voice-1',
		);
		await completeMutation(
			store.discardServer('voice-1', true),
			'DELETE',
			'/api/v1/voice-updates/voice-1',
		);
		expect(store.message()).toContain('history was retained');
		await completeMutation(
			store.discardServer('voice-1', false),
			'DELETE',
			'/api/v1/voice-updates/voice-1',
		);
		expect(store.message()).toContain('discarded');
	});

	it('maps review mutation errors and clears feedback', async () => {
		const store = configure();
		await selectAndFlush(store);

		const conflict = store.process('voice-1');
		await vi.waitFor(() =>
			http
				?.expectOne('/api/v1/voice-updates/voice-1/process')
				.flush(
					{ error: 'Review the processed draft first' },
					{ status: 409, statusText: 'Conflict' },
				),
		);
		await conflict;
		flushReloads();
		expect(store.error()).toBe('Review the processed draft first');

		const expired = store.correctText('voice-1', 'fix');
		await vi.waitFor(() =>
			http
				?.expectOne('/api/v1/voice-updates/voice-1/corrections')
				.flush('expired', { status: 401, statusText: 'Unauthorized' }),
		);
		await expired;
		flushReloads();
		expect(store.error()).toContain('session has expired');

		const generic = store.confirm('voice-1', false);
		await vi.waitFor(() =>
			http
				?.expectOne('/api/v1/voice-updates/voice-1/confirm')
				.flush('failed', { status: 500, statusText: 'Server Error' }),
		);
		await generic;
		flushReloads();
		expect(store.error()).toContain('could not be saved');
		store.clearFeedback();
		expect(store.error()).toBe('');
	});

	it('treats a missing navigator as online for queued retry', async () => {
		const store = configure();
		await selectAndFlush(store);
		queue.captures.set('server-rendered', capture('server-rendered'));
		vi.stubGlobal('navigator', undefined);
		const retry = store.retryQueued();
		await vi.waitFor(() => {
			expectUpload()?.flush({
				voiceUpdate: update({ id: 'server-rendered' }),
			});
		});
		await vi.waitFor(() => {
			http
				?.expectOne('/api/v1/voice-updates/server-rendered/process')
				.flush({ voiceUpdate: update({ id: 'server-rendered' }) });
		});
		await retry;
		flushReloads();
	});
});
