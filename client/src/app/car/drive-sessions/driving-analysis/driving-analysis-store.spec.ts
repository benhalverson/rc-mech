import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { concat, NEVER, Observable, of, Subject, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrivingAnalysisStore } from './driving-analysis-store';
import { PageVisibilityCapability } from './page-visibility';
import type {
	RaceRecording,
	RaceRecordingGatewayFailure,
	RaceRecordingTransferEvent,
} from './race-recording.models';
import { RaceRecordingFileCapability } from './race-recording-file';
import { RaceRecordingGateway } from './race-recording-gateway';

const recording = (overrides: Partial<RaceRecording> = {}): RaceRecording => ({
	id: 'recording-1',
	carId: 'car-1',
	driveSessionId: 'drive-1',
	fileName: 'Race.mp4',
	contentType: 'video/mp4',
	sizeBytes: 3,
	partSizeBytes: 2,
	status: 'uploading',
	uploadedBytes: 0,
	uploadedPartNumbers: [],
	validationStateVersion: null,
	media: null,
	validationError: null,
	validatedAt: null,
	playbackUrl: null,
	createdAt: '2026-08-16T20:00:00.000Z',
	updatedAt: '2026-08-16T20:00:00.000Z',
	expiresAt: '2026-08-23T20:00:00.000Z',
	completedAt: null,
	...overrides,
});

class FakeRaceRecordingGateway {
	readonly collectionValue = signal<readonly RaceRecording[]>([]);
	readonly collectionHasValue = signal(true);
	readonly collectionLoading = signal(false);
	readonly collectionError = signal<RaceRecordingGatewayFailure | null>(null);
	readonly collection = {
		hasValue: () => this.collectionHasValue(),
		value: () => this.collectionValue(),
		isLoading: () => this.collectionLoading(),
	};
	readonly selectCar = vi.fn();
	readonly refresh = vi.fn();
	readonly collectionFailure = vi.fn(() => this.collectionError());
	readonly createUpload = vi.fn<
		(_command: unknown) => Observable<RaceRecording>
	>(() => of(recording()));
	readonly uploadPart =
		vi.fn<
			(command: {
				partNumber: number;
				bytes: Blob;
			}) => Observable<RaceRecordingTransferEvent>
		>();
	readonly completeUpload = vi.fn<
		(_command: unknown) => Observable<RaceRecording>
	>(() => of(recording({ status: 'validating', uploadedBytes: 3 })));
	readonly deleteRecording = vi.fn<(_command: unknown) => Observable<void>>(
		() => of(undefined),
	);
}

describe('DrivingAnalysisStore', () => {
	let store: InstanceType<typeof DrivingAnalysisStore>;
	let gateway: FakeRaceRecordingGateway;
	let files: RaceRecordingFileCapability;
	let hidden: ReturnType<typeof signal<boolean>>;

	beforeEach(() => {
		gateway = new FakeRaceRecordingGateway();
		hidden = signal(false);
		let uploadedBytes = 0;
		const parts: number[] = [];
		gateway.uploadPart.mockImplementation((command) => {
			uploadedBytes += command.bytes.size;
			parts.push(command.partNumber);
			return concat(
				of({
					kind: 'progress' as const,
					loaded: command.bytes.size,
					total: command.bytes.size,
				}),
				of({
					kind: 'completed' as const,
					recording: recording({
						uploadedBytes,
						uploadedPartNumbers: [...parts],
					}),
				}),
			);
		});
		TestBed.configureTestingModule({
			providers: [
				DrivingAnalysisStore,
				RaceRecordingFileCapability,
				{ provide: RaceRecordingGateway, useValue: gateway },
				{ provide: PageVisibilityCapability, useValue: { hidden } },
			],
		});
		store = TestBed.inject(DrivingAnalysisStore);
		files = TestBed.inject(RaceRecordingFileCapability);
	});

	afterEach(() => TestBed.resetTestingModule());

	it('selects route context and projects resource state', () => {
		expect(store.recordings()).toEqual([]);
		expect(store.loading()).toBe(false);
		expect(store.readFailure()).toBeNull();
		expect(store.pending()).toBe(false);
		expect(store.removalPending()).toBe(false);
		expect(store.error()).toBe('');
		expect(store.removalError()).toBe('');
		expect(store.selectedFileName('missing')).toBe('');
		store.selectCar('car-1');
		store.selectCar('car-1');
		expect(gateway.selectCar).toHaveBeenCalledOnce();
		gateway.collectionValue.set([recording()]);
		gateway.collectionLoading.set(true);
		gateway.collectionError.set({ kind: 'http', status: 503 });
		expect(store.recordings()).toHaveLength(1);
		expect(store.loading()).toBe(true);
		expect(store.readFailure()).toEqual({ kind: 'http', status: 503 });
		gateway.collectionHasValue.set(false);
		expect(store.recordings()).toEqual([]);
		store.retry();
		expect(gateway.refresh).toHaveBeenCalledOnce();
	});

	it('refreshes validating recordings until authoritative state becomes terminal', async () => {
		vi.useFakeTimers();
		try {
			store.selectCar('car-1');
			gateway.collectionHasValue.set(false);
			await vi.advanceTimersByTimeAsync(3_000);
			expect(gateway.refresh).not.toHaveBeenCalled();

			gateway.collectionHasValue.set(true);
			gateway.collectionValue.set([recording()]);
			await vi.advanceTimersByTimeAsync(3_000);
			expect(gateway.refresh).not.toHaveBeenCalled();

			gateway.collectionValue.set([
				recording({
					status: 'validating',
					uploadedBytes: 3,
					completedAt: 'now',
					validationStateVersion: 1,
				}),
			]);
			await vi.advanceTimersByTimeAsync(3_000);
			expect(gateway.refresh).toHaveBeenCalledOnce();

			hidden.set(true);
			await vi.advanceTimersByTimeAsync(3_000);
			expect(gateway.refresh).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(27_000);
			expect(gateway.refresh).toHaveBeenCalledTimes(2);

			gateway.collectionValue.set([
				recording({
					status: 'invalid',
					uploadedBytes: 3,
					completedAt: 'now',
					validationStateVersion: 2,
					validatedAt: 'later',
					validationError: {
						code: 'CORRUPT_MEDIA',
						stage: 'probe',
						message: 'The recording is corrupt.',
					},
				}),
			]);
			await vi.advanceTimersByTimeAsync(30_000);
			expect(gateway.refresh).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('fails closed when a selected File has no creation-request identity', () => {
		store.selectCar('car-1');
		vi.spyOn(files, 'requestId').mockReturnValueOnce(null);
		store.startUpload({
			carId: 'car-1',
			driveSessionId: 'drive-1',
			file: new File(['abc'], 'Race.mp4', { type: 'video/mp4' }),
		});
		expect(store.transfer().status).toBe('failed');
		expect(store.error()).toContain('Choose the same');
		expect(gateway.createUpload).not.toHaveBeenCalled();
	});

	it('uploads only missing bounded parts and publishes progress and readiness', async () => {
		store.selectCar('car-1');
		const file = new File(['abc'], 'Race.mp4', { type: 'video/mp4' });
		store.startUpload({ carId: 'car-1', driveSessionId: 'drive-1', file });
		await vi.waitFor(() => expect(store.transfer().status).toBe('complete'));
		expect(gateway.createUpload).toHaveBeenCalledWith(
			expect.objectContaining({
				carId: 'car-1',
				driveSessionId: 'drive-1',
				fileName: 'Race.mp4',
				contentType: 'video/mp4',
				sizeBytes: 3,
				requestId: expect.any(String),
			}),
		);
		expect(gateway.uploadPart).toHaveBeenCalledTimes(2);
		expect(gateway.uploadPart).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				partNumber: 1,
				transferRequestId: 'recording-1:part:1',
			}),
		);
		expect(gateway.completeUpload).toHaveBeenCalledOnce();
		expect(store.transfer()).toMatchObject({
			status: 'complete',
			uploadedBytes: 3,
			totalBytes: 3,
		});
		expect(gateway.refresh).toHaveBeenCalledOnce();
		expect(files.file('drive-1')).toBeNull();
	});

	it('uses authoritative completed parts after a route reload', async () => {
		gateway.createUpload.mockReturnValue(
			of(
				recording({
					uploadedBytes: 2,
					uploadedPartNumbers: [1],
				}),
			),
		);
		store.selectCar('car-1');
		store.startUpload({
			carId: 'car-1',
			driveSessionId: 'drive-1',
			file: new File(['abc'], 'Race.mp4', { type: 'video/mp4' }),
		});
		await vi.waitFor(() => expect(store.transfer().status).toBe('complete'));
		expect(gateway.uploadPart).toHaveBeenCalledOnce();
		expect(gateway.uploadPart).toHaveBeenCalledWith(
			expect.objectContaining({ partNumber: 2 }),
		);
	});

	it('retains the File when the server does not confirm completion', async () => {
		gateway.completeUpload.mockReturnValue(
			of(recording({ uploadedBytes: 3, uploadedPartNumbers: [1, 2] })),
		);
		store.selectCar('car-1');
		store.startUpload({
			carId: 'car-1',
			driveSessionId: 'drive-1',
			file: new File(['abc'], 'Race.mp4', { type: 'video/mp4' }),
		});
		await vi.waitFor(() => expect(store.transfer().status).toBe('failed'));
		expect(store.error()).toContain('completion was not confirmed');
		expect(files.file('drive-1')).not.toBeNull();
	});

	it.each(['ready', 'invalid'] as const)(
		'accepts a fast terminal %s validation after upload completion',
		async (status) => {
			gateway.completeUpload.mockReturnValue(
				of(
					recording({ status, uploadedBytes: 3, uploadedPartNumbers: [1, 2] }),
				),
			);
			store.selectCar('car-1');
			store.startUpload({
				carId: 'car-1',
				driveSessionId: 'drive-1',
				file: new File(['abc'], 'Race.mp4', { type: 'video/mp4' }),
			});
			await vi.waitFor(() => expect(store.transfer().status).toBe('complete'));
			expect(files.file('drive-1')).toBeNull();
		},
	);

	it('pauses an active request and resumes with the retained private File', async () => {
		gateway.uploadPart.mockReturnValueOnce(NEVER);
		store.selectCar('car-1');
		store.startUpload({
			carId: 'car-1',
			driveSessionId: 'drive-1',
			file: new File(['abc'], 'Race.mp4', { type: 'video/mp4' }),
		});
		await vi.waitFor(() =>
			expect(store.transfer().recordingId).toBe('recording-1'),
		);
		store.pauseUpload('another-drive');
		expect(store.transfer().status).toBe('uploading');
		store.pauseUpload('drive-1');
		expect(store.transfer().status).toBe('paused');
		expect(store.hasSelectedFile('drive-1')).toBe(true);
		expect(store.selectedFileName('drive-1')).toBe('Race.mp4');

		gateway.uploadPart.mockImplementation((command) =>
			of({
				kind: 'completed',
				recording: recording({
					uploadedBytes: command.partNumber === 1 ? 2 : 3,
				}),
			}),
		);
		store.resumeUpload('drive-1');
		await vi.waitFor(() => expect(store.transfer().status).toBe('complete'));
	});

	it('fails safely when a resumed File is absent or mismatched', async () => {
		store.selectCar('car-1');
		store.resumeUpload('drive-1');
		expect(store.transfer().status).toBe('failed');
		expect(store.error()).toContain('Choose the same');

		gateway.createUpload.mockReturnValue(
			of(recording({ fileName: 'Different.mp4' })),
		);
		store.startUpload({
			carId: 'car-1',
			driveSessionId: 'drive-1',
			file: new File(['abc'], 'Race.mp4', { type: 'video/mp4' }),
		});
		await vi.waitFor(() => expect(store.transfer().status).toBe('failed'));
		expect(store.error()).toContain('Choose the same');
	});

	it.each([
		recording({ carId: 'other-car' }),
		recording({ driveSessionId: 'other-drive' }),
		recording({ contentType: 'video/webm' }),
		recording({ sizeBytes: 4 }),
	])(
		'rejects every mismatched immutable file field',
		async (serverRecording) => {
			gateway.createUpload.mockReturnValue(of(serverRecording));
			store.selectCar('car-1');
			store.startUpload({
				carId: 'car-1',
				driveSessionId: 'drive-1',
				file: new File(['abc'], 'Race.mp4', { type: 'video/mp4' }),
			});
			await vi.waitFor(() => expect(store.transfer().status).toBe('failed'));
		},
	);

	it('fails if the private File handle disappears before part slicing', async () => {
		const created = new Subject<RaceRecording>();
		gateway.createUpload.mockReturnValue(created);
		store.selectCar('car-1');
		store.startUpload({
			carId: 'car-1',
			driveSessionId: 'drive-1',
			file: new File(['abc'], 'Race.mp4', { type: 'video/mp4' }),
		});
		files.clear();
		created.next(recording());
		created.complete();
		await vi.waitFor(() => expect(store.transfer().status).toBe('failed'));
		expect(store.error()).toContain('Choose the same');
	});

	it.each([
		[
			{ kind: 'http', status: 401 } as RaceRecordingGatewayFailure,
			'session has expired',
		],
		[
			{
				kind: 'rejected-response',
				status: 409,
				message: 'Server rejected this file.',
			} as RaceRecordingGatewayFailure,
			'Server rejected this file',
		],
		[
			{ kind: 'unavailable' } as RaceRecordingGatewayFailure,
			'could not be uploaded',
		],
	])(
		'maps transfer failure %# to safe presentation copy',
		async (failure, copy) => {
			gateway.createUpload.mockReturnValue(throwError(() => failure));
			store.selectCar('car-1');
			store.startUpload({
				carId: 'car-1',
				driveSessionId: 'drive-1',
				file: new File(['abc'], 'Race.mp4', { type: 'video/mp4' }),
			});
			await vi.waitFor(() => expect(store.transfer().status).toBe('failed'));
			expect(store.error()).toContain(copy);
		},
	);

	it('removes current work, refreshes success, and publishes removal failure', async () => {
		store.selectCar('car-1');
		store.removeRecording({
			carId: 'other-car',
			driveSessionId: 'drive-1',
			recordingId: 'recording-1',
		});
		expect(gateway.deleteRecording).not.toHaveBeenCalled();

		gateway.uploadPart.mockReturnValueOnce(NEVER);
		store.startUpload({
			carId: 'car-1',
			driveSessionId: 'drive-1',
			file: new File(['abc'], 'Race.mp4', { type: 'video/mp4' }),
		});
		await vi.waitFor(() =>
			expect(store.transfer().recordingId).toBe('recording-1'),
		);
		const removed = new Subject<void>();
		gateway.deleteRecording.mockReturnValueOnce(removed);
		store.removeRecording({
			carId: 'car-1',
			driveSessionId: 'drive-1',
			recordingId: 'recording-1',
		});
		expect(store.pending()).toBe(true);
		expect(store.removalPending()).toBe(true);
		expect(store.transfer().status).toBe('paused');
		expect(store.removal()).toMatchObject({ status: 'removing' });
		removed.next();
		removed.complete();
		await vi.waitFor(() => expect(store.transfer().status).toBe('idle'));
		expect(gateway.refresh).toHaveBeenCalledOnce();

		gateway.deleteRecording.mockReturnValue(
			throwError(() => ({ kind: 'unavailable' })),
		);
		store.removeRecording({
			carId: 'car-1',
			driveSessionId: 'drive-1',
			recordingId: 'recording-1',
		});
		await vi.waitFor(() => expect(store.removal().status).toBe('failed'));
		expect(store.removalError()).toContain('could not be removed');
	});

	it.each([
		[
			{ kind: 'http', status: 401 } as RaceRecordingGatewayFailure,
			'session has expired',
		],
		[
			{
				kind: 'rejected-response',
				status: 409,
				message: 'Server rejected this removal.',
			} as RaceRecordingGatewayFailure,
			'Server rejected this removal',
		],
		[
			{ kind: 'http', status: 503 } as RaceRecordingGatewayFailure,
			'could not be removed',
		],
	])(
		'maps removal failure %# to safe presentation copy',
		async (failure, copy) => {
			gateway.deleteRecording.mockReturnValue(throwError(() => failure));
			store.selectCar('car-1');
			store.removeRecording({
				carId: 'car-1',
				driveSessionId: 'drive-1',
				recordingId: 'recording-1',
			});
			await vi.waitFor(() => expect(store.removal().status).toBe('failed'));
			expect(store.removalError()).toContain(copy);
		},
	);

	it('removes a paused recording without interrupting another Drive transfer', async () => {
		const transferStopped = vi.fn();
		gateway.uploadPart.mockReturnValueOnce(
			new Observable(() => transferStopped),
		);
		store.selectCar('car-1');
		store.startUpload({
			carId: 'car-1',
			driveSessionId: 'drive-1',
			file: new File(['abc'], 'Race.mp4', { type: 'video/mp4' }),
		});
		await vi.waitFor(() =>
			expect(store.transfer().recordingId).toBe('recording-1'),
		);

		store.removeRecording({
			carId: 'car-1',
			driveSessionId: 'drive-2',
			recordingId: 'recording-2',
		});

		expect(gateway.deleteRecording).toHaveBeenCalledWith({
			carId: 'car-1',
			driveSessionId: 'drive-2',
			recordingId: 'recording-2',
		});
		expect(store.transfer()).toMatchObject({
			status: 'uploading',
			driveSessionId: 'drive-1',
			recordingId: 'recording-1',
		});
		expect(transferStopped).not.toHaveBeenCalled();
	});

	it('drops invalid and stale route commands and clears private selections', async () => {
		store.selectCar('car-1');
		store.startUpload({
			carId: 'other-car',
			driveSessionId: 'drive-1',
			file: new File(['abc'], 'Race.mp4', { type: 'video/mp4' }),
		});
		expect(gateway.createUpload).not.toHaveBeenCalled();
		expect(files.file('drive-1')).toBeNull();
		store.selectCar('car-2');
		expect(files.file('drive-1')).toBeNull();
		expect(store.transfer().status).toBe('idle');
	});
});
