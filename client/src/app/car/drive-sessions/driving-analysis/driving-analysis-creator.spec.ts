import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackMapVersion } from '../../../track-maps/track-map.models';
import type { DrivingAnalysis } from './driving-analysis.models';
import { DrivingAnalysisCreator } from './driving-analysis-creator';
import type { ApprovedTrackMapOption } from './driving-analysis-store';
import { DrivingAnalysisStore } from './driving-analysis-store';
import type { RaceRecording } from './race-recording.models';
import { SubjectBoxEditor } from './subject-box-editor';

const recording: RaceRecording = {
	id: '33333333-3333-4333-8333-333333333333',
	carId: 'car-1',
	driveSessionId: 'drive-1',
	fileName: 'Main race.mov',
	contentType: 'video/quicktime',
	sizeBytes: 3,
	partSizeBytes: 10 * 1024 * 1024,
	status: 'ready',
	uploadedBytes: 3,
	uploadedPartNumbers: [1],
	validationStateVersion: 2,
	media: {
		byteCount: 3,
		durationMs: 1_200_000,
		width: 1920,
		height: 1080,
		videoCodec: 'h264',
		audioCodecs: [],
		containerFormats: ['mov'],
		decodedFrameCount: 36_000,
		averageFrameRate: { numerator: 30, denominator: 1 },
		timeBase: { numerator: 1, denominator: 90_000 },
		sampleAspectRatio: { numerator: 1, denominator: 1 },
		displayAspectRatio: { numerator: 16, denominator: 9 },
		startTimeMs: 0,
		checksumSha256: 'a'.repeat(64),
	},
	validationError: null,
	validatedAt: '2026-08-17T18:00:00.000Z',
	playbackUrl:
		'/api/v1/race-videos/33333333-3333-4333-8333-333333333333/content',
	createdAt: '2026-08-17T18:00:00.000Z',
	updatedAt: '2026-08-17T18:00:00.000Z',
	expiresAt: '2026-08-18T18:00:00.000Z',
	completedAt: '2026-08-17T18:00:00.000Z',
};

const maps: readonly ApprovedTrackMapOption[] = [
	{
		id: '44444444-4444-4444-8444-444444444444',
		layoutId: 'layout-1',
		layoutName: 'Indoor clay',
		version: 2,
		approvedAt: '2026-08-17T17:00:00.000Z',
	},
];

const selectedVersion: TrackMapVersion = {
	id: maps[0]?.id ?? '',
	layoutId: 'layout-1',
	version: 2,
	stateVersion: 2,
	status: 'approved',
	sourceVersionId: null,
	createdBy: 'owner-1',
	createdAt: '2026-08-17T16:00:00.000Z',
	updatedAt: '2026-08-17T17:00:00.000Z',
	approvedBy: 'owner-1',
	approvedAt: '2026-08-17T17:00:00.000Z',
	retiredAt: null,
	referenceFrame: {
		raceVideoId: '33333333-3333-4333-8333-333333333333',
		timestampMs: 100,
		byteCount: 100,
		checksumSha256: 'a'.repeat(64),
		contentType: 'image/jpeg',
		contentUrl: '/api/v1/track-map-versions/map-1/reference-frame/content',
	},
	corners: [
		{
			key: 'one',
			name: 'Corner one',
			order: 1,
			entryGate: {
				start: { x: 0.1, y: 0.2 },
				end: { x: 0.2, y: 0.2 },
				direction: 'forward',
			},
			exitGate: {
				start: { x: 0.3, y: 0.4 },
				end: { x: 0.4, y: 0.4 },
				direction: 'forward',
			},
			cornerView: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 },
		},
	],
};

class FakeStore {
	readonly approvedTrackMaps = signal(maps);
	readonly trackMapsLoading = signal(false);
	readonly trackMapsFailure = signal<unknown>(null);
	readonly selectedTrackMap = signal<TrackMapVersion | null>(selectedVersion);
	readonly selectedTrackMapLoading = signal(false);
	readonly pending = signal(false);
	readonly analysisCreation = signal<{
		status: 'idle' | 'creating' | 'retrying' | 'accepted' | 'failed';
		driveSessionId: string | null;
		analysis: DrivingAnalysis | null;
		error: unknown;
	}>({
		status: 'idle',
		driveSessionId: null as string | null,
		analysis: null as DrivingAnalysis | null,
		error: null,
	});
	readonly analysisError = signal('');
	readonly createAnalysis = vi.fn();
	readonly refreshAnalysis = vi.fn();
	readonly retryAnalysis = vi.fn();
	readonly selectTrackMap = vi.fn();
}

describe('DrivingAnalysisCreator', () => {
	let store: FakeStore;

	beforeEach(() => {
		store = new FakeStore();
		TestBed.configureTestingModule({
			imports: [DrivingAnalysisCreator],
			providers: [{ provide: DrivingAnalysisStore, useValue: store }],
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		TestBed.resetTestingModule();
	});

	it('marks absolute timestamps and submits the normalized Track-view seed', async () => {
		const fixture = TestBed.createComponent(DrivingAnalysisCreator);
		fixture.componentRef.setInput('carId', 'car-1');
		fixture.componentRef.setInput('driveSessionId', 'drive-1');
		fixture.componentRef.setInput('recording', recording);
		fixture.detectChanges();
		await fixture.whenStable();
		fixture.detectChanges();
		const root = fixture.nativeElement as HTMLElement;
		expect(root.textContent).toContain('Indoor clay · version 2');
		expect(root.textContent).toContain('Inspect immutable Track-map geometry');
		expect(store.selectTrackMap).toHaveBeenCalledWith(maps[0]?.id);
		expect(root.textContent).toContain('Absolute recording timestamp');
		const boxWidth = root.querySelector<HTMLInputElement>('[data-box-width]');
		if (!boxWidth) throw new Error('Subject-box width input missing');
		for (const value of ['0.12', '0.1']) {
			boxWidth.value = value;
			boxWidth.dispatchEvent(new Event('input', { bubbles: true }));
			fixture.detectChanges();
		}
		const video = root.querySelector<HTMLVideoElement>('video');
		if (!video) throw new Error('Video missing');
		Object.defineProperty(video, 'currentTime', {
			value: 120,
			writable: true,
			configurable: true,
		});
		video.dispatchEvent(new Event('timeupdate'));
		root.querySelector<HTMLButtonElement>('[data-mark-start]')?.click();
		video.currentTime = 720;
		video.dispatchEvent(new Event('timeupdate'));
		root.querySelector<HTMLButtonElement>('[data-mark-end]')?.click();
		video.currentTime = 180;
		video.dispatchEvent(new Event('timeupdate'));
		root.querySelector<HTMLButtonElement>('[data-mark-seed]')?.click();
		fixture.detectChanges();

		root
			.querySelector('form')
			?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		expect(store.createAnalysis).toHaveBeenCalledWith({
			carId: 'car-1',
			driveSessionId: 'drive-1',
			raceVideoId: recording.id,
			approvedTrackMapVersionId: maps[0]?.id,
			raceWindow: { startTimestampMs: 120_000, endTimestampMs: 720_000 },
			subjectSeed: {
				timestampMs: 180_000,
				frameIndex: 5_400,
				identity: 'subject-1',
				box: { x: 0.45, y: 0.45, width: 0.1, height: 0.08 },
			},
		});
		root
			.querySelector('form')
			?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		expect(store.createAnalysis).toHaveBeenCalledTimes(2);
		boxWidth.value = '';
		boxWidth.dispatchEvent(new Event('input', { bubbles: true }));
		root
			.querySelector('form')
			?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		fixture.detectChanges();
		expect(root.textContent).toContain(
			'Enter a complete normalized Subject box',
		);
		expect(store.createAnalysis).toHaveBeenCalledTimes(2);
		boxWidth.value = '0.1';
		boxWidth.dispatchEvent(new Event('input', { bubbles: true }));
		root
			.querySelector('form')
			?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		expect(store.createAnalysis).toHaveBeenCalledTimes(3);
		const identity = root.querySelector<HTMLInputElement>(
			'[data-subject-identity]',
		);
		const frameIndex = root.querySelector<HTMLInputElement>(
			'[data-seed-frame-index]',
		);
		if (!identity || !frameIndex)
			throw new Error('Subject-seed inputs missing');
		for (const value of ['', 'x'.repeat(129)]) {
			identity.value = value;
			identity.dispatchEvent(new Event('input', { bubbles: true }));
			root
				.querySelector('form')
				?.dispatchEvent(
					new Event('submit', { bubbles: true, cancelable: true }),
				);
			fixture.detectChanges();
			expect(root.textContent).toContain(
				'Subject identity must be between 1 and 128 characters',
			);
		}
		identity.value = 'subject-1';
		identity.dispatchEvent(new Event('input', { bubbles: true }));
		for (const value of ['-1', '36000', '1.5']) {
			frameIndex.value = value;
			frameIndex.dispatchEvent(new Event('input', { bubbles: true }));
			root
				.querySelector('form')
				?.dispatchEvent(
					new Event('submit', { bubbles: true, cancelable: true }),
				);
			fixture.detectChanges();
			expect(root.textContent).toContain(
				'Subject frame must identify a decoded recording frame',
			);
		}
		expect(store.createAnalysis).toHaveBeenCalledTimes(3);

		const editor = fixture.debugElement.query(By.directive(SubjectBoxEditor))
			.componentInstance as SubjectBoxEditor;
		const propertyFallback = fixture.componentInstance as unknown as {
			box: { x: number; y: number; width: number; height: number };
			boxValid: boolean;
		};
		propertyFallback.box = { x: 0, y: 0, width: 0.1, height: 0.1 };
		editor.box.set({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
		expect(propertyFallback.box).toEqual({
			x: 0.1,
			y: 0.2,
			width: 0.3,
			height: 0.4,
		});
		propertyFallback.boxValid = true;
		editor.valid.set(false);
		expect(propertyFallback.boxValid).toBe(false);
	});

	it('supports exact seek controls and presents validation and D1 progress', async () => {
		const fixture = TestBed.createComponent(DrivingAnalysisCreator);
		fixture.componentRef.setInput('carId', 'car-1');
		fixture.componentRef.setInput('driveSessionId', 'drive-1');
		fixture.componentRef.setInput('recording', recording);
		fixture.detectChanges();
		await fixture.whenStable();
		fixture.detectChanges();
		const root = fixture.nativeElement as HTMLElement;
		const video = root.querySelector<HTMLVideoElement>('video');
		const seek = root.querySelector<HTMLInputElement>('[data-race-seek]');
		if (!video || !seek) throw new Error('Player controls missing');
		Object.defineProperty(video, 'currentTime', {
			value: 0,
			writable: true,
			configurable: true,
		});
		let paused = true;
		Object.defineProperty(video, 'paused', {
			configurable: true,
			get: () => paused,
		});
		let playFailure: Error | null = null;
		const play = vi.fn(async () => {
			if (playFailure) throw playFailure;
			paused = false;
			video.dispatchEvent(new Event('play'));
		});
		const pause = vi.fn(() => {
			paused = true;
			video.dispatchEvent(new Event('pause'));
		});
		Object.defineProperty(video, 'play', { configurable: true, value: play });
		Object.defineProperty(video, 'pause', { configurable: true, value: pause });
		const playback = root.querySelector<HTMLButtonElement>(
			'[data-toggle-playback]',
		);
		playback?.click();
		await vi.waitFor(() => expect(play).toHaveBeenCalledOnce());
		fixture.detectChanges();
		expect(playback?.textContent).toContain('Pause recording');
		playback?.click();
		expect(pause).toHaveBeenCalledOnce();
		playFailure = new Error('Playback unavailable');
		playback?.click();
		await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(2));
		fixture.detectChanges();
		expect(playback?.textContent).toContain('Play recording');
		seek.value = '250000';
		seek.dispatchEvent(new Event('input', { bubbles: true }));
		expect(video.currentTime).toBe(250);

		const end = root.querySelector<HTMLInputElement>('[data-window-end]');
		if (!end) throw new Error('End input missing');
		end.value = '0';
		end.dispatchEvent(new Event('input', { bubbles: true }));
		root
			.querySelector('form')
			?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		fixture.detectChanges();
		expect(root.textContent).toContain('Race window must end after it starts');
		expect(store.createAnalysis).not.toHaveBeenCalled();

		store.analysisCreation.set({
			status: 'accepted',
			driveSessionId: 'drive-1',
			analysis: {
				id: 'analysis-1',
				status: 'running',
				stage: 'preparation',
				progress: 15,
			} as DrivingAnalysis,
			error: null,
		});
		fixture.detectChanges();
		expect(root.textContent).toContain('Preparation · 15%');
		root.querySelector<HTMLButtonElement>('[data-refresh-analysis]')?.click();
		expect(store.refreshAnalysis).toHaveBeenCalledOnce();
		root.querySelector<HTMLButtonElement>('[data-retry-analysis]')?.click();
		expect(store.retryAnalysis).toHaveBeenCalledOnce();
		expect(root.textContent).toContain('fresh workflow identity');
		store.analysisCreation.set({
			status: 'retrying',
			driveSessionId: 'drive-1',
			analysis: store.analysisCreation().analysis,
			error: null,
		});
		store.pending.set(true);
		fixture.detectChanges();
		expect(
			root.querySelector<HTMLButtonElement>('[data-retry-analysis]')
				?.textContent,
		).toContain('Retrying…');
		store.analysisCreation.set({
			status: 'accepted',
			driveSessionId: 'drive-1',
			analysis: {
				...store.analysisCreation().analysis,
				status: 'completed',
				stage: 'finalization',
				progress: 100,
			} as DrivingAnalysis,
			error: null,
		});
		fixture.detectChanges();
		expect(root.querySelector('[data-retry-analysis]')).not.toBeNull();
		store.analysisCreation.set({
			status: 'accepted',
			driveSessionId: 'drive-1',
			analysis: {
				...store.analysisCreation().analysis,
				status: 'running',
				stage: 'tracking',
				progress: 50,
			} as DrivingAnalysis,
			error: null,
		});
		store.pending.set(false);
		fixture.detectChanges();
		expect(root.querySelector('[data-retry-analysis]')).toBeNull();
		store.analysisCreation.set({
			...store.analysisCreation(),
			analysis: {
				...store.analysisCreation().analysis,
				status: 'failed',
			} as DrivingAnalysis,
		});
		fixture.detectChanges();
		expect(root.querySelector('[data-retry-analysis]')).not.toBeNull();
	});

	it('covers unavailable maps, validation boundaries, failures, and pending state', async () => {
		store.approvedTrackMaps.set([]);
		store.trackMapsLoading.set(true);
		const fixture = TestBed.createComponent(DrivingAnalysisCreator);
		fixture.componentRef.setInput('carId', 'car-1');
		fixture.componentRef.setInput('driveSessionId', 'drive-1');
		fixture.componentRef.setInput('recording', { ...recording, media: null });
		fixture.detectChanges();
		await fixture.whenStable();
		fixture.detectChanges();
		const root = fixture.nativeElement as HTMLElement;
		expect(root.textContent).toContain('Loading approved Track maps');
		root.querySelector<HTMLButtonElement>('[data-mark-seed]')?.click();

		store.trackMapsLoading.set(false);
		store.trackMapsFailure.set({ status: 503 });
		fixture.detectChanges();
		expect(root.textContent).toContain('Approved Track maps are unavailable');

		store.trackMapsFailure.set(null);
		fixture.detectChanges();
		expect(root.textContent).toContain(
			'No approved Track-map version is available yet',
		);
		root
			.querySelector('form')
			?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		fixture.detectChanges();
		expect(root.textContent).toContain('Choose an approved Track-map version');

		const approvedMap = maps[0];
		if (!approvedMap) throw new Error('Approved Track map fixture missing');
		store.approvedTrackMaps.set([{ ...approvedMap, approvedAt: null }]);
		store.selectedTrackMap.set(null);
		store.selectedTrackMapLoading.set(true);
		fixture.detectChanges();
		expect(root.textContent).toContain('Approved previously');
		expect(root.textContent).toContain('Loading immutable Track-map geometry');
		store.selectedTrackMapLoading.set(false);

		const setNumber = (selector: string, value: string): void => {
			const input = root.querySelector<HTMLInputElement>(selector);
			if (!input) throw new Error(`${selector} missing`);
			input.value = value;
			input.dispatchEvent(new Event('input', { bubbles: true }));
			fixture.detectChanges();
		};
		setNumber('[data-window-start]', '0');
		setNumber('[data-window-end]', '900001');
		setNumber('[data-seed-timestamp]', '900001');
		root
			.querySelector('form')
			?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		fixture.detectChanges();
		expect(root.textContent).toContain(
			'Race window must be 15 minutes or shorter',
		);

		store.analysisCreation.set({
			status: 'failed',
			driveSessionId: 'drive-1',
			analysis: null,
			error: { status: 409 },
		});
		store.analysisError.set(
			'The immutable request conflicts with an existing one.',
		);
		fixture.detectChanges();
		expect(root.textContent).toContain('immutable request conflicts');

		store.analysisCreation.set({
			status: 'creating',
			driveSessionId: 'drive-1',
			analysis: null,
			error: null,
		});
		fixture.detectChanges();
		const submit = root.querySelector<HTMLButtonElement>(
			'[data-create-analysis]',
		);
		expect(submit?.disabled).toBe(true);
		expect(submit?.textContent).toContain('Starting');

		store.analysisCreation.set({
			status: 'failed',
			driveSessionId: 'another-drive',
			analysis: null,
			error: null,
		});
		store.pending.set(true);
		fixture.detectChanges();
		expect(submit?.disabled).toBe(true);
		expect(submit?.textContent).toContain('Start analysis');
	});
});
