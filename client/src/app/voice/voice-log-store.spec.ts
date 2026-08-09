import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError, type Observable } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OwnerSessionStore } from '../owner-session-store';
import { VoiceConnectivity } from './voice-connectivity';
import { VoiceGateway } from './voice-gateway';
import { VoiceLogStore } from './voice-log-store';
import type {
	PendingVoiceCapture,
	VoiceContextCar,
	VoiceGatewayFailure,
	VoiceMutationResponse,
	VoiceUpdate,
} from './voice.models';
import { VoiceOfflineQueue } from './voice-offline-queue';
import { VoiceRecorder } from './voice-recorder';

const draft = {
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
	status: 'needs-review',
	contentType: null,
	fileName: null,
	byteSize: 0,
	audioUrl: null,
	transcript: 'Track note',
	draft,
	corrections: [],
	clarificationPrompt: null,
	error: null,
	confirmedAt: null,
	artifactDeletedAt: null,
	createdAt: '2026-08-09T01:00:00.000Z',
	updatedAt: '2026-08-09T01:00:00.000Z',
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
	createdAt: '2026-08-09T01:00:00.000Z',
	status: 'local',
	error: null,
	...overrides,
});

class FakeResource<T> {
	private readonly current = signal<T | undefined>(undefined);
	readonly loading = signal(false);
	readonly failure = signal<unknown>(undefined);
	readonly hasValue = (): boolean => this.current() !== undefined;
	readonly value = (): T => {
		const value = this.current();
		if (value === undefined) throw new Error('No resource value');
		return value;
	};
	readonly isLoading = this.loading;
	readonly error = this.failure;
	readonly reload = vi.fn();

	set(value: T | undefined): void {
		this.current.set(value);
	}
}

class FakeGateway {
	readonly updates = new FakeResource<readonly VoiceUpdate[]>();
	readonly contextCars = new FakeResource<readonly VoiceContextCar[]>();
	readonly selectCar = vi.fn();
	readonly refresh = vi.fn();
	readonly readFailure = signal<VoiceGatewayFailure | null>(null);
	readonly updatesFailure = vi.fn<() => VoiceGatewayFailure | null>(() =>
		this.readFailure(),
	);
	readonly upload = vi.fn<
		(capture: PendingVoiceCapture) => Observable<VoiceMutationResponse>
	>(() => of({ voiceUpdate: update({ status: 'pending' }) }));
	readonly process = vi.fn<(id: string) => Observable<VoiceMutationResponse>>(
		() => of({ voiceUpdate: update() }),
	);
	readonly correctText = vi.fn<
		(id: string, text: string) => Observable<VoiceMutationResponse>
	>(() => of({ voiceUpdate: update() }));
	readonly correctAudio = vi.fn<
		(id: string, blob: Blob) => Observable<VoiceMutationResponse>
	>(() => of({ voiceUpdate: update() }));
	readonly confirm = vi.fn<
		(id: string, accept: boolean) => Observable<VoiceMutationResponse>
	>(() => of({ voiceUpdate: update({ status: 'saved' }) }));
	readonly updateContext = vi.fn<
		(
			id: string,
			carId: string,
			driveSessionId: string | null,
		) => Observable<VoiceMutationResponse>
	>(() => of({ voiceUpdate: update() }));
	readonly discard = vi.fn<(id: string) => Observable<VoiceMutationResponse>>(
		() => of({ voiceUpdate: update({ status: 'discarded' }) }),
	);
}

class FakeQueue {
	readonly captures = new Map<string, PendingVoiceCapture>();
	nextId = 'capture-1';
	readonly createId = vi.fn(() => this.nextId);
	readonly put = vi.fn(async (value: PendingVoiceCapture) => {
		this.captures.set(value.id, value);
	});
	readonly list = vi.fn(async (ownerKey: string) =>
		[...this.captures.values()].filter((value) => value.ownerKey === ownerKey),
	);
	readonly updateStatus = vi.fn(
		async (
			id: string,
			status: PendingVoiceCapture['status'],
			error: string | null,
		) => {
			const value = this.captures.get(id);
			if (value) this.captures.set(id, { ...value, status, error });
		},
	);
	readonly remove = vi.fn(async (id: string) => {
		this.captures.delete(id);
	});
}

class FakeRecorder {
	readonly checking = signal(false);
	readonly supported = signal(true);
	readonly starting = signal(false);
	readonly recording = signal(false);
	readonly elapsedSeconds = signal(0);
	readonly inputLevel = signal(0);
	readonly audioDetected = signal(false);
	readonly inputMuted = signal(false);
	readonly detectSupport = vi.fn(async () => true);
	readonly start = vi.fn(async () => undefined);
	readonly stop = vi.fn(
		async () => new Blob(['voice'], { type: 'audio/webm' }),
	);
	readonly cancel = vi.fn();
}

describe('VoiceLogStore', () => {
	let store: InstanceType<typeof VoiceLogStore>;
	let gateway: FakeGateway;
	let queue: FakeQueue;
	let recorder: FakeRecorder;
	let connectivity: { isOnline: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		gateway = new FakeGateway();
		queue = new FakeQueue();
		recorder = new FakeRecorder();
		connectivity = { isOnline: vi.fn(() => true) };
		TestBed.configureTestingModule({
			providers: [
				VoiceLogStore,
				{ provide: VoiceGateway, useValue: gateway },
				{ provide: VoiceOfflineQueue, useValue: queue },
				{ provide: VoiceRecorder, useValue: recorder },
				{ provide: VoiceConnectivity, useValue: connectivity },
				{
					provide: OwnerSessionStore,
					useValue: { ownerEmail: signal(' Owner@Example.Test ') },
				},
			],
		});
		store = TestBed.inject(VoiceLogStore);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		TestBed.resetTestingModule();
	});

	const select = async (): Promise<void> => {
		store.selectCar('car-1');
		await vi.waitFor(() => expect(queue.list).toHaveBeenCalled());
	};

	it('derives route-safe reads, active context cars, recorder state, and local captures', async () => {
		expect(store.updates()).toEqual([]);
		expect(store.cars()).toEqual([]);
		expect(store.loading()).toBe(false);
		expect(store.readError()).toBe('');
		expect(store.pending()).toBe(false);
		expect(store.action()).toBeNull();
		expect(store.error()).toBe('');
		queue.captures.set('matching', capture('matching'));
		queue.captures.set('other-car', capture('other-car', { carId: 'car-2' }));
		queue.captures.set(
			'other-owner',
			capture('other-owner', { ownerKey: 'another@example.test' }),
		);
		gateway.updates.set([update(), update({ id: 'other', carId: 'car-2' })]);
		gateway.contextCars.set([{ id: 'car-1', name: 'Buggy', archivedAt: null }]);
		gateway.updates.loading.set(true);
		connectivity.isOnline.mockReturnValue(false);
		await select();
		expect(store.localCaptures().map(({ id }) => id)).toEqual(['matching']);
		expect(store.updates().map(({ id }) => id)).toEqual(['voice-1']);
		expect(store.cars()).toHaveLength(1);
		expect(store.loading()).toBe(true);
		expect(gateway.selectCar).toHaveBeenCalledWith('car-1');
		expect(recorder.cancel).toHaveBeenCalledOnce();
		store.selectCar('car-1');
		store.selectCar('');
		expect(gateway.selectCar).toHaveBeenCalledOnce();

		recorder.checking.set(true);
		recorder.supported.set(false);
		recorder.starting.set(true);
		recorder.recording.set(true);
		recorder.elapsedSeconds.set(3);
		recorder.inputLevel.set(0.5);
		recorder.audioDetected.set(true);
		recorder.inputMuted.set(true);
		expect([
			store.checking(),
			store.supported(),
			store.starting(),
			store.recording(),
			store.elapsedSeconds(),
			store.inputLevel(),
			store.audioDetected(),
			store.inputMuted(),
		]).toEqual([true, false, true, true, 3, 0.5, true, true]);
	});

	it('automatically retries persisted captures when a car is selected', async () => {
		queue.captures.set('queued', capture('queued'));
		store.selectCar('car-1');
		await vi.waitFor(() => expect(gateway.upload).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(store.message()).toContain('checked'));
		expect(queue.captures.has('queued')).toBe(false);

		store.selectCar('car-2');
		await vi.waitFor(() => expect(queue.list).toHaveBeenCalledTimes(3));
		expect(store.outcome().status).toBe('idle');
	});

	it('reports a selected-car local queue read failure', async () => {
		queue.list.mockRejectedValueOnce(new Error('IndexedDB unavailable'));
		store.selectCar('car-1');
		await vi.waitFor(() => expect(store.outcome().status).toBe('failed'));
		expect(store.error()).toContain('stored safely');
	});

	it('does not overlap automatic queue work with an active command', async () => {
		let resolveList: ((captures: PendingVoiceCapture[]) => void) | undefined;
		queue.list.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveList = resolve;
				}),
		);
		let resolveStart: (() => void) | undefined;
		recorder.start.mockImplementationOnce(
			() =>
				new Promise<undefined>((resolve) => {
					resolveStart = () => resolve(undefined);
				}),
		);
		store.selectCar('car-1');
		store.startRecording({ kind: 'capture' });
		resolveList?.([capture('queued')]);
		await Promise.resolve();
		expect(gateway.upload).not.toHaveBeenCalled();

		resolveStart?.();
		await vi.waitFor(() => expect(store.outcome().status).toBe('succeeded'));
		store.selectCar('car-2');
		let rejectList: ((error: unknown) => void) | undefined;
		queue.list.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					rejectList = reject;
				}),
		);
		recorder.start.mockImplementationOnce(
			() => new Promise<undefined>(() => undefined),
		);
		store.selectCar('car-3');
		store.startRecording({ kind: 'capture' });
		rejectList?.(new Error('queue failed while recording'));
		await Promise.resolve();
		expect(store.outcome().status).toBe('pending');
	});

	it('ignores automatic queue load failures after route selection changes', async () => {
		let rejectList: ((error: unknown) => void) | undefined;
		queue.list.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					rejectList = reject;
				}),
		);
		store.selectCar('car-1');
		store.selectCar('car-2');
		rejectList?.(new Error('stale queue failure'));
		await Promise.resolve();
		expect(store.outcome().status).toBe('idle');
	});

	it('maps all voice-history read failures and refreshes', () => {
		gateway.readFailure.set({ kind: 'http', status: 401 });
		expect(store.readError()).toContain('session has expired');
		gateway.readFailure.set({ kind: 'invalid-response' });
		expect(store.readError()).toContain('invalid');
		gateway.readFailure.set({ kind: 'unavailable' });
		expect(store.readError()).toContain('could not be loaded');
		store.retryRead();
		expect(gateway.refresh).toHaveBeenCalledOnce();
		store.detectRecorderSupport();
		expect(recorder.detectSupport).toHaveBeenCalledOnce();
		store.clearFeedback();
		expect(store.outcome().status).toBe('idle');
	});

	it('keeps an optimistic mutation until a newer remote version arrives', async () => {
		gateway.updates.set([
			update({ status: 'pending', updatedAt: '2026-08-09T01:00:00.000Z' }),
		]);
		await select();
		gateway.process.mockReturnValueOnce(
			of({
				voiceUpdate: update({
					status: 'needs-review',
					updatedAt: '2026-08-09T02:00:00.000Z',
				}),
			}),
		);
		store.process('voice-1');
		await vi.waitFor(() =>
			expect(store.updates()[0]?.status).toBe('needs-review'),
		);
		gateway.updates.set([
			update({ status: 'saved', updatedAt: '2026-08-09T03:00:00.000Z' }),
		]);
		expect(store.updates()[0]?.status).toBe('saved');

		gateway.updateContext.mockReturnValueOnce(
			of({
				voiceUpdate: update({
					carId: 'car-2',
					updatedAt: '2026-08-09T04:00:00.000Z',
				}),
			}),
		);
		store.updateContext({
			id: 'voice-1',
			carId: 'car-2',
			driveSessionId: null,
		});
		await vi.waitFor(() => expect(store.outcome().status).toBe('succeeded'));
		expect(store.updates()).toEqual([
			update({ status: 'saved', updatedAt: '2026-08-09T03:00:00.000Z' }),
		]);
	});

	it('starts, cancels, and rejects microphone operations with typed outcomes', async () => {
		await select();
		store.startRecording({ kind: 'capture' });
		expect(store.recordingMode()).toEqual({ kind: 'capture' });
		store.startRecording({ kind: 'capture' });
		await vi.waitFor(() => expect(store.outcome().status).toBe('succeeded'));
		expect(recorder.start).toHaveBeenCalledOnce();
		store.cancelRecording();
		expect(recorder.cancel).toHaveBeenCalledTimes(2);
		expect(store.recorderError()).toContain('cancelled');

		recorder.start.mockRejectedValueOnce(
			new DOMException('Denied', 'NotAllowedError'),
		);
		store.startRecording({ kind: 'capture' });
		await vi.waitFor(() =>
			expect(store.error()).toContain('access was denied'),
		);
		expect(store.recordingMode()).toBeNull();
		store.clearFeedback();
		recorder.start.mockRejectedValueOnce(new Error('Recorder failed'));
		store.startRecording({ kind: 'capture' });
		await vi.waitFor(() => expect(store.error()).toBe('Recorder failed'));
		store.clearFeedback();
		recorder.start.mockRejectedValueOnce('unknown');
		store.startRecording({ kind: 'correction', id: 'voice-1' });
		await vi.waitFor(() =>
			expect(store.error()).toContain('microphone could not be started'),
		);
	});

	it('captures text and audio, processes inline review, and suppresses duplicates', async () => {
		await select();
		store.captureText({ text: '   ', driveSessionId: null });
		expect(store.error()).toContain('Describe the track note');
		store.clearFeedback();

		const processResponse = update({ id: 'processed', status: 'needs-review' });
		gateway.process.mockReturnValueOnce(of({ voiceUpdate: processResponse }));
		store.captureText({
			text: '  Rear stepped out  ',
			driveSessionId: 'drive-1',
		});
		store.captureText({ text: 'duplicate', driveSessionId: null });
		await vi.waitFor(() => expect(store.outcome().status).toBe('succeeded'));
		expect(queue.put).toHaveBeenCalledOnce();
		expect(queue.put.mock.calls[0]?.[0]).toMatchObject({
			text: 'Rear stepped out',
			driveSessionId: 'drive-1',
			contentType: 'text/plain',
			fileName: 'voice-capture-1.txt',
		});
		expect(store.updates()[0]).toEqual(processResponse);
		expect(store.message()).toContain('ready for review');
		expect(gateway.refresh).toHaveBeenCalled();

		store.clearFeedback();
		queue.nextId = 'audio-1';
		store.startRecording({ kind: 'capture' });
		await vi.waitFor(() => expect(store.outcome().status).toBe('succeeded'));
		store.stopRecording({ driveSessionId: null });
		await vi.waitFor(() => expect(queue.put).toHaveBeenCalledTimes(2));
		expect(queue.put.mock.calls[1]?.[0]).toMatchObject({
			id: 'audio-1',
			contentType: 'audio/webm',
			fileName: 'voice-audio-1.webm',
		});
		await vi.waitFor(() => expect(store.outcome().status).toBe('succeeded'));

		store.clearFeedback();
		queue.nextId = 'audio-mp4';
		recorder.stop.mockResolvedValueOnce(
			new Blob(['voice'], { type: 'audio/mp4' }),
		);
		store.startRecording({ kind: 'capture' });
		await vi.waitFor(() => expect(store.outcome().status).toBe('succeeded'));
		store.stopRecording({ driveSessionId: null });
		await vi.waitFor(() => expect(store.outcome().status).toBe('succeeded'));
		expect(queue.put.mock.calls.at(-1)?.[0]).toMatchObject({
			contentType: 'audio/mp4',
			fileName: 'voice-audio-mp4.m4a',
		});

		store.clearFeedback();
		queue.nextId = 'audio-untyped';
		recorder.stop.mockResolvedValueOnce(new Blob(['voice']));
		store.startRecording({ kind: 'capture' });
		await vi.waitFor(() => expect(store.outcome().status).toBe('succeeded'));
		store.stopRecording({ driveSessionId: null });
		await vi.waitFor(() => expect(store.outcome().status).toBe('succeeded'));
		expect(queue.put.mock.calls.at(-1)?.[0]).toMatchObject({
			contentType: 'audio/webm',
			fileName: 'voice-audio-untyped.webm',
		});

		store.clearFeedback();
		queue.nextId = 'processing';
		gateway.process.mockReturnValueOnce(
			of({ voiceUpdate: update({ id: 'processing', status: 'processing' }) }),
		);
		store.captureText({ text: 'Still processing', driveSessionId: null });
		await vi.waitFor(() => expect(store.message()).toContain('processing'));
	});

	it('keeps captures locally when offline or upload and processing fail', async () => {
		await select();
		connectivity.isOnline.mockReturnValue(false);
		store.captureText({ text: 'Offline note', driveSessionId: null });
		await vi.waitFor(() => expect(store.outcome().status).toBe('succeeded'));
		expect(gateway.upload).not.toHaveBeenCalled();
		expect(queue.updateStatus).toHaveBeenCalledWith(
			'capture-1',
			'queued',
			'Waiting for a connection.',
		);
		expect(store.message()).toContain('queued for upload');

		store.clearFeedback();
		connectivity.isOnline.mockReturnValue(true);
		queue.nextId = 'unavailable';
		gateway.upload.mockReturnValueOnce(
			throwError(() => ({ kind: 'unavailable' })),
		);
		store.captureText({ text: 'Retry me', driveSessionId: null });
		await vi.waitFor(() => expect(store.outcome().status).toBe('succeeded'));
		expect(queue.captures.get('unavailable')).toMatchObject({
			status: 'queued',
		});

		store.clearFeedback();
		queue.nextId = 'rejected';
		gateway.upload.mockReturnValueOnce(
			throwError(() => ({
				kind: 'rejected-response',
				status: 422,
				message: 'Audio rejected.',
			})),
		);
		store.captureText({ text: 'Rejected note', driveSessionId: null });
		await vi.waitFor(() => expect(store.outcome().status).toBe('failed'));
		expect(queue.captures.get('rejected')).toMatchObject({
			status: 'failed',
			error: 'Audio rejected.',
		});
		expect(store.error()).toBe('Audio rejected.');

		store.clearFeedback();
		queue.nextId = 'process-failed';
		gateway.process.mockReturnValueOnce(throwError(() => new Error('process')));
		store.captureText({ text: 'Process later', driveSessionId: null });
		await vi.waitFor(() => expect(store.outcome().status).toBe('failed'));
		expect(store.error()).toContain('could not be processed');

		store.clearFeedback();
		queue.nextId = 'remove-failed';
		queue.remove.mockRejectedValueOnce(new Error('local remove failed'));
		store.captureText({ text: 'Idempotent upload', driveSessionId: null });
		await vi.waitFor(() => expect(store.outcome().status).toBe('succeeded'));
		expect(queue.captures.get('remove-failed')).toMatchObject({
			status: 'queued',
		});
	});

	it('reports local persistence and recording completion failures', async () => {
		await select();
		queue.put.mockRejectedValueOnce(new Error('IndexedDB closed'));
		store.captureText({ text: 'Store me', driveSessionId: null });
		await vi.waitFor(() => expect(store.outcome().status).toBe('failed'));
		expect(store.error()).toContain('stored safely');

		store.clearFeedback();
		store.startRecording({ kind: 'capture' });
		await vi.waitFor(() => expect(store.outcome().status).toBe('succeeded'));
		recorder.starting.set(true);
		store.stopRecording({ driveSessionId: null });
		expect(recorder.stop).not.toHaveBeenCalled();
		recorder.starting.set(false);
		recorder.stop.mockRejectedValueOnce(new Error('No audio detected'));
		store.stopRecording({ driveSessionId: null });
		await vi.waitFor(() => expect(store.error()).toBe('No audio detected'));

		store.clearFeedback();
		store.startRecording({ kind: 'capture' });
		await vi.waitFor(() => expect(store.outcome().status).toBe('succeeded'));
		recorder.stop.mockRejectedValueOnce('unknown');
		store.stopRecording({ driveSessionId: null });
		await vi.waitFor(() =>
			expect(store.error()).toContain('microphone could not be started'),
		);
	});

	it('suppresses every duplicate command while an operation is pending', async () => {
		await select();
		let resolveStop: ((blob: Blob) => void) | undefined;
		recorder.stop.mockImplementationOnce(
			() =>
				new Promise<Blob>((resolve) => {
					resolveStop = resolve;
				}),
		);
		store.startRecording({ kind: 'capture' });
		await vi.waitFor(() => expect(store.outcome().status).toBe('succeeded'));
		store.stopRecording({ driveSessionId: null });
		expect(store.action()).toBe('capture-audio:');
		store.stopRecording({ driveSessionId: null });
		store.startRecording({ kind: 'capture' });
		store.retryQueued();
		store.discardLocal('local-1');
		store.correctText({ id: 'voice-1', text: '   ' });
		store.process('voice-1');
		expect(recorder.stop).toHaveBeenCalledOnce();
		expect(gateway.process).not.toHaveBeenCalled();
		resolveStop?.(new Blob(['voice'], { type: 'audio/webm' }));
		await vi.waitFor(() => expect(store.outcome().status).toBe('succeeded'));

		store.clearFeedback();
		gateway.process.mockClear();
		const mutation = new Subject<VoiceMutationResponse>();
		gateway.process.mockReturnValueOnce(mutation);
		store.process('voice-1');
		store.startRecording({ kind: 'capture' });
		store.process('voice-2');
		expect(gateway.process).toHaveBeenCalledOnce();
		mutation.next({ voiceUpdate: update() });
		mutation.complete();
		await vi.waitFor(() => expect(store.outcome().status).toBe('succeeded'));
	});

	it('retries owner captures and discards local data with failure protection', async () => {
		await select();
		connectivity.isOnline.mockReturnValue(false);
		store.retryQueued();
		expect(queue.list).toHaveBeenCalledTimes(1);
		connectivity.isOnline.mockReturnValue(true);
		queue.captures.set('queued', capture('queued'));
		store.retryQueued();
		await vi.waitFor(() => expect(store.message()).toContain('checked'));
		expect(gateway.upload).toHaveBeenCalled();

		store.clearFeedback();
		queue.captures.set('retry-rejected', capture('retry-rejected'));
		queue.captures.set('retry-process', capture('retry-process'));
		gateway.upload
			.mockReturnValueOnce(
				throwError(() => ({
					kind: 'rejected-response',
					status: 422,
					message: 'Retry rejected.',
				})),
			)
			.mockReturnValueOnce(
				of({ voiceUpdate: update({ id: 'retry-process' }) }),
			);
		gateway.process.mockReturnValueOnce(
			throwError(() => ({ kind: 'unavailable' })),
		);
		store.retryQueued();
		await vi.waitFor(() => expect(store.outcome().status).toBe('failed'));
		expect(store.error()).toBe('Retry rejected.');

		store.clearFeedback();
		queue.list.mockRejectedValueOnce(new Error('queue unavailable'));
		store.retryQueued();
		await vi.waitFor(() => expect(store.outcome().status).toBe('failed'));
		expect(store.error()).toContain('stored safely');

		store.clearFeedback();
		queue.captures.set('discard-me', capture('discard-me'));
		store.discardLocal('discard-me');
		await vi.waitFor(() => expect(store.message()).toContain('discarded'));
		expect(queue.captures.has('discard-me')).toBe(false);

		store.clearFeedback();
		queue.remove.mockRejectedValueOnce(new Error('delete failed'));
		store.discardLocal('failed-delete');
		await vi.waitFor(() => expect(store.outcome().status).toBe('failed'));
		expect(store.error()).toContain('could not be discarded');
	});

	it('publishes review mutation outcomes, messages, and context destinations', async () => {
		await select();
		store.process('voice-1');
		await vi.waitFor(() => expect(store.outcome().status).toBe('succeeded'));
		expect(gateway.process).toHaveBeenCalledWith('voice-1');

		store.clearFeedback();
		gateway.correctText.mockReturnValueOnce(
			of({
				voiceUpdate: update(),
				correction: { outcome: 'manual-note' },
			}),
		);
		store.correctText({ id: 'voice-1', text: '  rear, not front  ' });
		await vi.waitFor(() => expect(store.message()).toContain('free-form note'));
		expect(gateway.correctText).toHaveBeenCalledWith(
			'voice-1',
			'rear, not front',
		);

		store.clearFeedback();
		store.correctText({ id: 'voice-1', text: '   ' });
		expect(store.error()).toContain('Say or type');
		store.clearFeedback();
		store.correctText({ id: 'voice-1', text: 'correct' });
		await vi.waitFor(() =>
			expect(store.message()).toContain('Draft corrected'),
		);

		store.clearFeedback();
		store.confirm('voice-1', true);
		await vi.waitFor(() => expect(store.message()).toContain('saved'));
		store.clearFeedback();
		store.updateContext({
			id: 'voice-1',
			carId: 'car-2',
			driveSessionId: null,
		});
		await vi.waitFor(() =>
			expect(store.outcome()).toMatchObject({ destinationCarId: 'car-2' }),
		);
		store.clearFeedback();
		store.discardServer('voice-1', true);
		await vi.waitFor(() => expect(store.message()).toContain('retained'));
		store.clearFeedback();
		store.discardServer('voice-1', false);
		await vi.waitFor(() => expect(store.message()).toContain('discarded'));
	});

	it('records voice corrections through the same typed outcome channel', async () => {
		await select();
		store.startRecording({ kind: 'correction', id: 'voice-1' });
		await vi.waitFor(() => expect(store.outcome().status).toBe('succeeded'));
		store.stopRecording({ driveSessionId: null });
		await vi.waitFor(() =>
			expect(store.message()).toContain('Draft corrected'),
		);
		expect(gateway.correctAudio).toHaveBeenCalledWith(
			'voice-1',
			expect.any(Blob),
		);

		store.clearFeedback();
		gateway.correctAudio.mockReturnValueOnce(
			throwError(() => ({ kind: 'unavailable' })),
		);
		store.startRecording({ kind: 'correction', id: 'voice-1' });
		await vi.waitFor(() => expect(store.outcome().status).toBe('succeeded'));
		store.stopRecording({ driveSessionId: null });
		await vi.waitFor(() =>
			expect(store.error()).toContain('could not be applied'),
		);
	});

	it.each([
		['process', 'The voice note could not be processed'],
		['correct-text', 'correction could not be applied'],
		['confirm', 'could not be saved'],
		['update-context', 'context could not be changed'],
		['discard-server', 'could not be removed'],
	] as const)(
		'maps %s unavailable failures to operation copy',
		async (operation, copy) => {
			await select();
			const failure = throwError(() => ({ kind: 'unavailable' as const }));
			switch (operation) {
				case 'process':
					gateway.process.mockReturnValueOnce(failure);
					store.process('voice-1');
					break;
				case 'correct-text':
					gateway.correctText.mockReturnValueOnce(failure);
					store.correctText({ id: 'voice-1', text: 'fix' });
					break;
				case 'confirm':
					gateway.confirm.mockReturnValueOnce(failure);
					store.confirm('voice-1', false);
					break;
				case 'update-context':
					gateway.updateContext.mockReturnValueOnce(failure);
					store.updateContext({
						id: 'voice-1',
						carId: 'car-1',
						driveSessionId: null,
					});
					break;
				case 'discard-server':
					gateway.discard.mockReturnValueOnce(failure);
					store.discardServer('voice-1', false);
					break;
			}
			await vi.waitFor(() => expect(store.error()).toContain(copy));
		},
	);

	it('preserves server messages and maps auth, invalid, HTTP, and unknown failures', async () => {
		await select();
		gateway.process.mockReturnValueOnce(
			throwError(() => ({
				kind: 'rejected-response',
				status: 409,
				message: 'Review the current draft.',
			})),
		);
		store.process('voice-1');
		await vi.waitFor(() =>
			expect(store.error()).toBe('Review the current draft.'),
		);

		store.clearFeedback();
		gateway.process.mockReturnValueOnce(
			throwError(() => ({ kind: 'http', status: 401 })),
		);
		store.process('voice-1');
		await vi.waitFor(() =>
			expect(store.error()).toContain('session has expired'),
		);

		store.clearFeedback();
		gateway.process.mockReturnValueOnce(
			throwError(() => ({ kind: 'invalid-response' })),
		);
		store.process('voice-1');
		await vi.waitFor(() => expect(store.error()).toContain('invalid response'));

		store.clearFeedback();
		gateway.process.mockReturnValueOnce(
			throwError(() => ({ kind: 'http', status: 503 })),
		);
		store.process('voice-1');
		await vi.waitFor(() =>
			expect(store.error()).toContain('could not be processed'),
		);

		store.clearFeedback();
		gateway.process.mockReturnValueOnce(throwError(() => new Error('boom')));
		store.process('voice-1');
		await vi.waitFor(() => expect(store.error()).toContain('stored safely'));

		store.clearFeedback();
		gateway.process.mockReturnValueOnce(throwError(() => 'unknown'));
		store.process('voice-1');
		await vi.waitFor(() => expect(store.error()).toContain('stored safely'));
	});

	it('ignores stale async completions after selecting another car', async () => {
		await select();
		const mutation = new Subject<VoiceMutationResponse>();
		gateway.process.mockReturnValueOnce(mutation);
		store.process('voice-1');
		expect(store.pending()).toBe(true);
		store.clearFeedback();
		expect(store.pending()).toBe(true);
		store.selectCar('car-2');
		mutation.next({ voiceUpdate: update() });
		mutation.complete();
		await Promise.resolve();
		expect(store.outcome().status).toBe('idle');
		expect(store.updates()).toEqual([]);

		const failure = new Subject<VoiceMutationResponse>();
		gateway.process.mockReturnValueOnce(failure);
		store.process('voice-2');
		store.selectCar('car-3');
		failure.error({ kind: 'unavailable' });
		await Promise.resolve();
		expect(store.outcome().status).toBe('idle');
	});

	it('ignores stale recorder and voice-correction completions', async () => {
		await select();
		let resolveStart: (() => void) | undefined;
		recorder.start.mockImplementationOnce(
			() =>
				new Promise<undefined>((resolve) => {
					resolveStart = () => resolve(undefined);
				}),
		);
		store.startRecording({ kind: 'capture' });
		store.selectCar('car-2');
		resolveStart?.();
		await Promise.resolve();
		expect(store.outcome().status).toBe('idle');

		let rejectStart: ((error: unknown) => void) | undefined;
		recorder.start.mockImplementationOnce(
			() =>
				new Promise<undefined>((_resolve, reject) => {
					rejectStart = reject;
				}),
		);
		store.startRecording({ kind: 'capture' });
		store.selectCar('car-3');
		rejectStart?.(new Error('stale start'));
		await Promise.resolve();
		expect(store.outcome().status).toBe('idle');

		recorder.start.mockResolvedValue(undefined);
		store.startRecording({ kind: 'capture' });
		await vi.waitFor(() => expect(store.outcome().status).toBe('succeeded'));
		let resolveStop: ((blob: Blob) => void) | undefined;
		recorder.stop.mockImplementationOnce(
			() =>
				new Promise<Blob>((resolve) => {
					resolveStop = resolve;
				}),
		);
		queue.put.mockClear();
		store.stopRecording({ driveSessionId: null });
		store.selectCar('car-4');
		resolveStop?.(new Blob(['stale']));
		await Promise.resolve();
		expect(queue.put).not.toHaveBeenCalled();

		store.startRecording({ kind: 'capture' });
		await vi.waitFor(() => expect(store.outcome().status).toBe('succeeded'));
		let rejectStop: ((error: unknown) => void) | undefined;
		recorder.stop.mockImplementationOnce(
			() =>
				new Promise<Blob>((_resolve, reject) => {
					rejectStop = reject;
				}),
		);
		store.stopRecording({ driveSessionId: null });
		store.selectCar('car-5');
		rejectStop?.(new Error('stale stop'));
		await Promise.resolve();
		expect(store.outcome().status).toBe('idle');

		const correction = new Subject<VoiceMutationResponse>();
		gateway.correctAudio.mockReturnValueOnce(correction);
		store.startRecording({ kind: 'correction', id: 'voice-1' });
		await vi.waitFor(() => expect(store.outcome().status).toBe('succeeded'));
		store.stopRecording({ driveSessionId: null });
		await vi.waitFor(() => expect(gateway.correctAudio).toHaveBeenCalled());
		store.selectCar('car-6');
		correction.next({ voiceUpdate: update() });
		correction.complete();
		await Promise.resolve();
		expect(store.outcome().status).toBe('idle');

		const failedCorrection = new Subject<VoiceMutationResponse>();
		gateway.correctAudio.mockReturnValueOnce(failedCorrection);
		store.startRecording({ kind: 'correction', id: 'voice-2' });
		await vi.waitFor(() => expect(store.outcome().status).toBe('succeeded'));
		store.stopRecording({ driveSessionId: null });
		await vi.waitFor(() =>
			expect(gateway.correctAudio).toHaveBeenCalledTimes(2),
		);
		store.selectCar('car-7');
		failedCorrection.error({ kind: 'unavailable' });
		await Promise.resolve();
		expect(store.outcome().status).toBe('idle');
	});

	it('guards local queue success and failure work with the route generation', async () => {
		let resolveList: ((captures: PendingVoiceCapture[]) => void) | undefined;
		queue.list.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveList = resolve;
				}),
		);
		store.selectCar('car-1');
		store.selectCar('car-2');
		resolveList?.([capture('stale')]);
		await Promise.resolve();
		expect(store.localCaptures()).toEqual([]);

		let resolvePut: (() => void) | undefined;
		queue.put.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					resolvePut = resolve;
				}),
		);
		store.captureText({ text: 'stale success', driveSessionId: null });
		store.selectCar('car-3');
		resolvePut?.();
		await vi.waitFor(() => expect(gateway.upload).toHaveBeenCalled());
		expect(store.outcome().status).toBe('idle');

		let rejectPut: ((error: unknown) => void) | undefined;
		queue.put.mockImplementationOnce(
			() =>
				new Promise<void>((_resolve, reject) => {
					rejectPut = reject;
				}),
		);
		store.captureText({ text: 'stale failure', driveSessionId: null });
		store.selectCar('car-4');
		rejectPut?.(new Error('stale'));
		await Promise.resolve();
		expect(store.outcome().status).toBe('idle');
	});

	it('guards queued retry and local discard completions after route changes', async () => {
		await select();
		const listCalls = queue.list.mock.calls.length;
		let resolveRetryReload:
			| ((captures: PendingVoiceCapture[]) => void)
			| undefined;
		queue.list.mockResolvedValueOnce([]).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveRetryReload = resolve;
				}),
		);
		store.retryQueued();
		await vi.waitFor(() =>
			expect(queue.list).toHaveBeenCalledTimes(listCalls + 2),
		);
		store.selectCar('reload-target');
		resolveRetryReload?.([]);
		await Promise.resolve();
		expect(store.outcome().status).toBe('idle');

		let resolveRetryList:
			| ((captures: PendingVoiceCapture[]) => void)
			| undefined;
		queue.list.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveRetryList = resolve;
				}),
		);
		store.retryQueued();
		store.selectCar('car-2');
		resolveRetryList?.([]);
		await Promise.resolve();
		expect(store.outcome().status).toBe('idle');

		let rejectRetryList: ((error: unknown) => void) | undefined;
		queue.list.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					rejectRetryList = reject;
				}),
		);
		store.retryQueued();
		store.selectCar('car-3');
		rejectRetryList?.(new Error('stale retry'));
		await Promise.resolve();
		expect(store.outcome().status).toBe('idle');

		let resolveRemove: (() => void) | undefined;
		queue.remove.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					resolveRemove = resolve;
				}),
		);
		store.discardLocal('stale');
		store.selectCar('car-4');
		resolveRemove?.();
		await Promise.resolve();
		expect(store.outcome().status).toBe('idle');

		let rejectRemove: ((error: unknown) => void) | undefined;
		queue.remove.mockImplementationOnce(
			() =>
				new Promise<void>((_resolve, reject) => {
					rejectRemove = reject;
				}),
		);
		store.discardLocal('stale-error');
		store.selectCar('car-5');
		rejectRemove?.(new Error('stale remove'));
		await Promise.resolve();
		expect(store.outcome().status).toBe('idle');
	});
});
