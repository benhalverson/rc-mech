import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriveSession } from '../drive-session.models';
import { DrivingAnalysisStore } from './driving-analysis-store';
import type {
	RaceRecording,
	RaceRecordingGatewayFailure,
	RaceRecordingTransferState,
} from './race-recording.models';
import { MAX_RACE_RECORDING_BYTES } from './race-recording.models';
import { RaceRecordingUpload } from './race-recording-upload';

const driveSession: DriveSession = {
	id: 'drive-1',
	carId: 'car-1',
	startedAt: '2026-08-16T20:00:00.000Z',
	durationMinutes: 20,
	conditions: 'Dry',
	notes: null,
	deletedAt: null,
};

const recording = (overrides: Partial<RaceRecording> = {}): RaceRecording => ({
	id: 'recording-1',
	carId: 'car-1',
	driveSessionId: 'drive-1',
	fileName: 'Race.mp4',
	contentType: 'video/mp4',
	sizeBytes: 3,
	partSizeBytes: 2,
	status: 'uploading',
	uploadedBytes: 1,
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

const idleTransfer = (): RaceRecordingTransferState => ({
	status: 'idle',
	driveSessionId: null,
	recordingId: null,
	uploadedBytes: 0,
	totalBytes: 0,
	error: null,
});

class FakeDrivingAnalysisStore {
	readonly recordings = signal<readonly RaceRecording[]>([]);
	readonly transfer = signal<RaceRecordingTransferState>(idleTransfer());
	readonly pending = signal(false);
	readonly approvedTrackMaps = signal([]);
	readonly trackMapsLoading = signal(false);
	readonly trackMapsFailure = signal<unknown>(null);
	readonly selectedTrackMap = signal(null);
	readonly selectedTrackMapLoading = signal(false);
	readonly analysisCreation = signal({
		status: 'idle' as 'idle' | 'creating' | 'accepted' | 'failed',
		driveSessionId: null as string | null,
		analysis: null,
		error: null,
	});
	readonly analysisError = signal('Analysis failed.');
	readonly error = signal('Upload failed.');
	readonly removal = signal<{
		status: 'idle' | 'removing' | 'failed';
		driveSessionId: string | null;
		recordingId: string | null;
		error: RaceRecordingGatewayFailure | null;
	}>({
		status: 'idle',
		driveSessionId: null,
		recordingId: null,
		error: null,
	});
	readonly removalPending = signal(false);
	readonly removalError = signal('Removal failed.');
	readonly readFailure = signal<unknown>(null);
	readonly selectedFile = signal(false);
	readonly selectedFileNameValue = signal('');
	readonly selectCar = vi.fn();
	readonly startUpload = vi.fn();
	readonly pauseUpload = vi.fn();
	readonly resumeUpload = vi.fn();
	readonly removeRecording = vi.fn();
	readonly retry = vi.fn();
	readonly createAnalysis = vi.fn();
	readonly refreshAnalysis = vi.fn();
	readonly selectTrackMap = vi.fn();
	readonly hasSelectedFile = vi.fn(() => this.selectedFile());
	readonly selectedFileName = vi.fn(() => this.selectedFileNameValue());
}

describe('RaceRecordingUpload', () => {
	let fixture: ComponentFixture<RaceRecordingUpload>;
	let store: FakeDrivingAnalysisStore;

	beforeEach(async () => {
		store = new FakeDrivingAnalysisStore();
		await TestBed.configureTestingModule({
			imports: [RaceRecordingUpload],
			providers: [{ provide: DrivingAnalysisStore, useValue: store }],
		}).compileComponents();
		fixture = TestBed.createComponent(RaceRecordingUpload);
		fixture.componentRef.setInput('carId', 'car-1');
		fixture.componentRef.setInput('driveSession', driveSession);
	});

	afterEach(() => TestBed.resetTestingModule());

	const detect = (): HTMLElement => {
		fixture.detectChanges();
		return fixture.nativeElement as HTMLElement;
	};

	const button = (label: string): HTMLButtonElement => {
		const match = [
			...(fixture.nativeElement as HTMLElement).querySelectorAll('button'),
		].find((candidate) => candidate.textContent?.includes(label));
		if (!match) throw new Error(`Button not found: ${label}`);
		return match;
	};

	const choose = (file: File | null): void => {
		const input = (fixture.nativeElement as HTMLElement).querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		Object.defineProperty(input, 'files', {
			configurable: true,
			value: { item: () => file },
		});
		input.dispatchEvent(new Event('change'));
		fixture.detectChanges();
	};

	it('selects route context, dispatches one validated file intent, and moves focus to Pause', async () => {
		const root = detect();
		expect(store.selectCar).toHaveBeenCalledWith('car-1');
		expect(root.textContent).toContain(
			'Attach private static-camera race footage',
		);
		choose(null);
		expect(store.startUpload).not.toHaveBeenCalled();
		const file = new File(['abc'], 'Race.mp4', { type: 'video/mp4' });
		choose(file);
		expect(store.startUpload).toHaveBeenCalledWith({
			carId: 'car-1',
			driveSessionId: 'drive-1',
			file,
		});
		store.transfer.set({
			status: 'uploading',
			driveSessionId: 'drive-1',
			recordingId: 'recording-1',
			uploadedBytes: 0,
			totalBytes: 3,
			error: null,
		});
		detect();
		detect();
		await fixture.whenStable();
		expect(document.activeElement).toBe(
			(fixture.nativeElement as HTMLElement).querySelector(
				'[data-race-recording-pause]',
			),
		);
	});

	it('rejects unsupported, empty, oversized, and concurrent selections locally', () => {
		let root = detect();
		choose(new File(['abc'], 'Race.avi', { type: 'video/x-msvideo' }));
		expect(root.querySelector('[role="alert"]')?.textContent).toContain(
			'MP4, MOV, or WebM',
		);
		choose(new File([], 'Race.mp4', { type: 'video/mp4' }));
		expect(root.querySelector('[role="alert"]')?.textContent).toContain(
			'10 GiB',
		);

		const oversized = new File(['a'], 'Race.mp4', { type: 'video/mp4' });
		Object.defineProperty(oversized, 'size', {
			value: MAX_RACE_RECORDING_BYTES + 1,
		});
		choose(oversized);
		expect(root.querySelector('[role="alert"]')?.textContent).toContain(
			'10 GiB',
		);

		store.pending.set(true);
		root = detect();
		const component = fixture.componentInstance as unknown as {
			selectFile(event: Event): void;
		};
		const concurrentInput = document.createElement('input');
		Object.defineProperty(concurrentInput, 'files', {
			value: {
				item: () => new File(['a'], 'Race.mp4', { type: 'video/mp4' }),
			},
		});
		component.selectFile({
			target: concurrentInput,
		} as unknown as Event);
		detect();
		expect(root.querySelector('[role="alert"]')?.textContent).toContain(
			'Finish the current upload',
		);
		expect(store.startUpload).not.toHaveBeenCalled();
	});

	it('renders progress, dispatches controls, and restores focus after cancellation', async () => {
		store.recordings.set([recording()]);
		store.transfer.set({
			status: 'uploading',
			driveSessionId: 'drive-1',
			recordingId: 'recording-1',
			uploadedBytes: 2,
			totalBytes: 3,
			error: null,
		});
		let root = detect();
		expect(root.textContent).toContain('Race.mp4 · 3 bytes');
		expect(root.querySelector('progress')?.getAttribute('value')).toBe('67');
		button('Pause').click();
		expect(store.pauseUpload).toHaveBeenCalledWith('drive-1');
		button('Cancel upload').click();
		expect(store.removeRecording).toHaveBeenCalledWith({
			carId: 'car-1',
			driveSessionId: 'drive-1',
			recordingId: 'recording-1',
		});
		store.transfer.set(idleTransfer());
		store.recordings.set([]);
		detect();
		detect();
		await fixture.whenStable();
		expect(document.activeElement).toBe(
			(fixture.nativeElement as HTMLElement).querySelector(
				'[data-race-recording-file]',
			),
		);

		store.selectedFile.set(true);
		store.recordings.set([recording()]);
		store.transfer.set({
			status: 'paused',
			driveSessionId: 'drive-1',
			recordingId: 'recording-1',
			uploadedBytes: 2,
			totalBytes: 3,
			error: null,
		});
		root = detect();
		expect(root.textContent).toContain('Upload paused');
		button('Resume').click();
		expect(store.resumeUpload).toHaveBeenCalledWith('drive-1');
	});

	it('renders authoritative reload, completed, failure, and read-error states', () => {
		store.recordings.set([recording()]);
		let root = detect();
		expect(root.textContent).toContain('Upload paused');
		expect(root.textContent).toContain('Choose same file');

		store.recordings.set([
			recording({ status: 'validating', uploadedBytes: 3, completedAt: 'now' }),
		]);
		root = detect();
		expect(root.textContent).toContain('Validating recording');
		button('Check status').click();
		expect(store.retry).toHaveBeenCalledOnce();
		expect(root.querySelector('input[type="file"]')).toBeNull();
		expect(root.textContent).toContain('Delete recording permanently');
		const component = fixture.componentInstance as unknown as {
			remove(): void;
		};
		component.remove();
		expect(store.removeRecording).toHaveBeenCalledWith({
			carId: 'car-1',
			driveSessionId: 'drive-1',
			recordingId: 'recording-1',
		});

		store.recordings.set([]);
		store.transfer.set({
			status: 'complete',
			driveSessionId: 'drive-1',
			recordingId: 'recording-1',
			uploadedBytes: 3,
			totalBytes: 3,
			error: null,
		});
		root = detect();
		expect(root.textContent).toContain('Validating recording');
		expect(root.textContent).toContain('Delete recording permanently');
		expect(root.textContent).not.toContain('Cancel upload');

		store.recordings.set([recording()]);
		store.transfer.set({
			status: 'failed',
			driveSessionId: 'drive-1',
			recordingId: 'recording-1',
			uploadedBytes: 1,
			totalBytes: 3,
			error: { kind: 'unavailable' },
		});
		root = detect();
		expect(root.textContent).toContain('Upload stopped');
		expect(root.textContent).toContain('Upload failed');

		store.transfer.set(idleTransfer());
		store.recordings.set([
			recording({
				status: 'ready',
				uploadedBytes: 3,
				completedAt: 'now',
				validationStateVersion: 2,
				validatedAt: 'later',
				playbackUrl: '/api/v1/race-videos/recording-1/content',
				media: {
					byteCount: 3,
					durationMs: 1000,
					width: 1920,
					height: 1080,
					videoCodec: 'h264',
					audioCodecs: [],
					containerFormats: ['mp4'],
					decodedFrameCount: 60,
					averageFrameRate: { numerator: 60, denominator: 1 },
					timeBase: { numerator: 1, denominator: 60 },
					sampleAspectRatio: { numerator: 1, denominator: 1 },
					displayAspectRatio: { numerator: 16, denominator: 9 },
					startTimeMs: 0,
					checksumSha256: 'a'.repeat(64),
				},
			}),
		]);
		root = detect();
		expect(root.textContent).toContain('Ready for analysis');
		expect(root.querySelector('video')?.getAttribute('src')).toBe(
			'/api/v1/race-videos/recording-1/content',
		);
		expect(root.textContent).toContain('1920 × 1080');

		store.recordings.set([
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
		root = detect();
		expect(root.textContent).toContain('Recording can’t be analyzed');
		expect(root.textContent).toContain('The recording is corrupt.');
		expect(root.querySelector('video')).toBeNull();

		store.transfer.set(idleTransfer());
		store.recordings.set([]);
		store.readFailure.set({ kind: 'http', status: 503 });
		root = detect();
		expect(root.textContent).toContain('Recording status unavailable');
		button('Try again').click();
		expect(store.retry).toHaveBeenCalledTimes(2);
	});

	it('keeps archived and deleted Drive sessions upload-read-only and guards absent removal', () => {
		fixture.componentRef.setInput('carArchived', true);
		let root = detect();
		expect(root.querySelector('input[type="file"]')).toBeNull();
		fixture.componentRef.setInput('carArchived', false);
		fixture.componentRef.setInput('driveSession', {
			...driveSession,
			deletedAt: 'now',
		});
		root = detect();
		expect(root.querySelector('input[type="file"]')).toBeNull();
		const component = fixture.componentInstance as unknown as {
			remove(): void;
		};
		component.remove();
		expect(store.removeRecording).not.toHaveBeenCalled();
	});

	it('renders identified removal progress and failure without changing another card', () => {
		store.recordings.set([
			recording({ status: 'validating', uploadedBytes: 3, completedAt: 'now' }),
		]);
		store.removal.set({
			status: 'removing',
			driveSessionId: 'drive-1',
			recordingId: 'recording-1',
			error: null,
		});
		store.removalPending.set(true);
		let root = detect();
		expect(root.textContent).toContain('Removing recording');
		expect(root.textContent).not.toContain('Delete recording permanently');

		store.removal.set({
			status: 'failed',
			driveSessionId: 'drive-1',
			recordingId: 'recording-1',
			error: { kind: 'unavailable' },
		});
		store.removalPending.set(false);
		root = detect();
		expect(root.textContent).toContain('Removal stopped');
		expect(root.textContent).toContain('Removal failed');
		expect(root.textContent).toContain('Delete recording permanently');
	});

	it('caps presentation progress and renders a zero-total transfer safely', () => {
		const values = fixture.componentInstance as unknown as {
			declaredSize(): string;
			uploadedBytes(): number;
			totalBytes(): number;
		};
		expect(values.declaredSize()).toBe('');
		expect(values.uploadedBytes()).toBe(0);
		expect(values.totalBytes()).toBe(0);
		store.transfer.set({
			status: 'uploading',
			driveSessionId: 'drive-1',
			recordingId: null,
			uploadedBytes: 4,
			totalBytes: 3,
			error: null,
		});
		store.selectedFileNameValue.set('Fresh.mp4');
		let root = detect();
		expect(root.textContent).toContain('Fresh.mp4 · 3 bytes');
		expect(root.querySelector('progress')?.getAttribute('value')).toBe('100');
		store.transfer.update((value) => ({
			...value,
			uploadedBytes: 0,
			totalBytes: 0,
			status: 'cancelling',
		}));
		root = detect();
		expect(root.textContent).toContain('Removing recording');
		expect(root.querySelector('progress')?.getAttribute('value')).toBe('0');
	});
});
