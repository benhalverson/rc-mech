import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CorrectionPlayer } from './correction-player';
import type { DrivingAnalysis } from './driving-analysis.models';
import type { RaceRecording } from './race-recording.models';
import type { ReidentificationContext } from './reidentification.models';
import { ReidentificationStore } from './reidentification-store';
import { SubjectBoxEditor } from './subject-box-editor';
import { SubjectReidentification } from './subject-reidentification';

const analysis: DrivingAnalysis = {
	id: 'analysis',
	requestId: 'request',
	carId: 'car',
	driveSessionId: 'drive',
	raceVideoId: 'video',
	approvedTrackMapVersionId: 'map',
	raceWindow: { startTimestampMs: 0, endTimestampMs: 1000 },
	subjectSeed: {
		timestampMs: 100,
		frameIndex: 1,
		identity: 'car',
		box: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
	},
	sourceLayout: {
		version: 'fixed-track-view.v1',
		digest: 'a'.repeat(64),
		width: 1920,
		height: 1080,
		trackView: { x: 0, y: 1 / 3, width: 1, height: 2 / 3 },
	},
	lifecycle: 'awaiting-reidentification',
	status: 'awaiting-reidentification',
	stage: 'tracking',
	progress: 99,
	stateVersion: 1,
	createdAt: 'now',
	updatedAt: 'now',
};
const recording: RaceRecording = {
	id: 'video',
	carId: 'car',
	driveSessionId: 'drive',
	fileName: 'Race.mp4',
	contentType: 'video/mp4',
	sizeBytes: 100,
	partSizeBytes: 100,
	status: 'ready',
	uploadedBytes: 100,
	uploadedPartNumbers: [1],
	validationStateVersion: 1,
	media: {
		byteCount: 100,
		durationMs: 1000,
		width: 1920,
		height: 1080,
		videoCodec: 'h264',
		audioCodecs: [],
		containerFormats: ['mp4'],
		decodedFrameCount: 30,
		averageFrameRate: { numerator: 30, denominator: 1 },
		timeBase: { numerator: 1, denominator: 30 },
		sampleAspectRatio: { numerator: 1, denominator: 1 },
		displayAspectRatio: { numerator: 16, denominator: 9 },
		startTimeMs: 0,
		checksumSha256: 'a'.repeat(64),
	},
	validationError: null,
	validatedAt: 'now',
	playbackUrl: '/private-video',
	createdAt: 'now',
	updatedAt: 'now',
	expiresAt: 'later',
	completedAt: 'now',
};
const gap: ReidentificationContext = {
	runId: 'run',
	segmentId: 'segment',
	acceptedDigest: 'a'.repeat(64),
	frames: [{ frameIndex: 15, timestampMs: 500 }],
	gap: { startTimestampMs: 250, reason: 'missing' },
};

const setup = async () => {
	vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(
		() => undefined,
	);
	const store = {
		context: signal<ReidentificationContext | null>(gap),
		loading: signal(false),
		readFailed: signal(false),
		outcome: signal<{ status: 'idle' | 'pending' | 'failed' | 'succeeded' }>({
			status: 'idle',
		}),
		select: vi.fn(),
		correct: vi.fn(),
	};
	TestBed.configureTestingModule({
		imports: [SubjectReidentification],
		providers: [
			CorrectionPlayer,
			{ provide: ReidentificationStore, useValue: store },
		],
	});
	const fixture = TestBed.createComponent(SubjectReidentification);
	fixture.componentRef.setInput('analysis', analysis);
	fixture.componentRef.setInput('recording', recording);
	fixture.detectChanges();
	await fixture.whenStable();
	const element: HTMLElement = fixture.nativeElement;
	const input = (selector: string, value: string) => {
		const field = element.querySelector<HTMLInputElement>(selector);
		if (!field) throw new Error('Missing input');
		field.value = value;
		field.dispatchEvent(new Event('input', { bubbles: true }));
		fixture.detectChanges();
		return field;
	};
	const submit = () => {
		element
			.querySelector('form')
			?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		fixture.detectChanges();
	};
	return { fixture, element, store, input, submit };
};
afterEach(() => {
	vi.restoreAllMocks();
	TestBed.resetTestingModule();
});

describe('SubjectReidentification', () => {
	it('retries the immutable saved correction after remount and ignores stale clicks', async () => {
		const f = await setup();
		const saved = {
			...gap,
			pendingCorrection: {
				correctionId: 'saved',
				subjectSeed: {
					...analysis.subjectSeed,
					timestampMs: 500,
					frameIndex: 15,
				},
			},
		};
		f.store.context.set(saved);
		f.fixture.detectChanges();
		const button = f.element.querySelector<HTMLButtonElement>('button');
		if (!button) throw new Error('Missing retry');
		button.click();
		expect(f.store.correct).toHaveBeenCalledWith({
			analysisId: analysis.id,
			context: saved,
			subjectSeed: saved.pendingCorrection.subjectSeed,
		});
		f.store.context.set(gap);
		button.click();
		f.store.context.set(null);
		button.click();
		expect(f.store.correct).toHaveBeenCalledOnce();
	});
	it('supports Angular property fallbacks for both editor model outputs', async () => {
		const f = await setup();
		const editor = f.fixture.debugElement.query(By.directive(SubjectBoxEditor))
			.componentInstance as SubjectBoxEditor;
		const propertyFallback = f.fixture.componentInstance as unknown as {
			box: DrivingAnalysis['subjectSeed']['box'];
			boxValid: boolean;
		};
		propertyFallback.box = analysis.subjectSeed.box;
		editor.box.set({ ...analysis.subjectSeed.box, width: 0.2 });
		expect(propertyFallback.box.width).toBe(0.2);
		propertyFallback.boxValid = true;
		editor.valid.set(false);
		expect(propertyFallback.boxValid).toBe(false);
	});
	it('initializes and submits the only manifest frame without a slider input', async () => {
		const f = await setup();
		expect(f.element.textContent).toContain('250 ms (missing)');
		expect(f.element.textContent).toContain(gap.acceptedDigest);
		const player = f.element.querySelector('video');
		if (!player) throw new Error('Missing video');
		const pause = vi.mocked(player.pause);
		expect(
			f.element.querySelector<HTMLInputElement>('input[type=range]')?.max,
		).toBe('0');
		expect(player.currentTime).toBe(0.5);
		expect(pause).toHaveBeenCalledOnce();
		player.currentTime = 0;
		player.dispatchEvent(new Event('loadedmetadata'));
		expect(player.currentTime).toBe(0.5);
		expect(pause).toHaveBeenCalledTimes(2);
		f.submit();
		expect(f.store.correct).toHaveBeenCalledWith({
			analysisId: analysis.id,
			context: gap,
			subjectSeed: {
				...analysis.subjectSeed,
				timestampMs: 500,
				frameIndex: 15,
			},
		});
		f.fixture.componentRef.setInput('analysis', { ...analysis, progress: 98 });
		f.fixture.detectChanges();
		expect(f.element.textContent).toContain('frame 15 at 500 ms');
		const range =
			f.element.querySelector<HTMLInputElement>('input[type=range]');
		if (!range) throw new Error('Missing range');
		Object.defineProperty(range, 'valueAsNumber', { value: Number.NaN });
		range.dispatchEvent(new Event('input'));
		expect(pause).toHaveBeenCalledTimes(2);
	});
	it('seeks selected frames and resets to the first frame of a subsequent gap', async () => {
		const f = await setup();
		f.store.context.set({
			...gap,
			frames: [...gap.frames, { frameIndex: 19, timestampMs: 650 }],
		});
		f.fixture.detectChanges();
		f.input('input[type=range]', '1');
		expect(f.element.querySelector('video')?.currentTime).toBe(0.65);
		f.store.context.set({
			...gap,
			segmentId: 'next',
			frames: [{ frameIndex: 21, timestampMs: 700 }],
		});
		f.fixture.detectChanges();
		expect(
			f.element.querySelector<HTMLInputElement>('input[type=range]')?.value,
		).toBe('0');
		expect(f.element.querySelector('video')?.currentTime).toBe(0.7);
		f.submit();
		expect(f.store.correct).toHaveBeenCalledWith(
			expect.objectContaining({
				subjectSeed: expect.objectContaining({
					frameIndex: 21,
					timestampMs: 700,
				}),
			}),
		);
	});
	it('rejects stale, nonfinite, out-of-window, invalid-frame, and invalid-box input with focus', async () => {
		const f = await setup();
		f.store.context.set({
			...gap,
			frames: [{ frameIndex: -1, timestampMs: 500 }],
		});
		f.fixture.detectChanges();
		f.submit();
		expect(f.store.correct).not.toHaveBeenCalled();
		expect(document.activeElement?.getAttribute('type')).toBe('range');
		f.store.context.set({ ...gap, frames: [] });
		f.submit();
		f.store.context.set(gap);
		f.fixture.detectChanges();
		f.store.context.set({
			...gap,
			frames: [{ frameIndex: 15, timestampMs: 250 }],
		});
		f.input('input[type=range]', '0');
		f.submit();
		f.store.context.set({
			...gap,
			frames: [{ frameIndex: 15, timestampMs: 1000 }],
		});
		f.input('input[type=range]', '0');
		f.submit();
		f.store.context.set(gap);
		f.input('input[type=range]', '0');
		const editor = f.fixture.debugElement.query(By.directive(SubjectBoxEditor))
			.componentInstance as SubjectBoxEditor;
		editor.box.set({ ...analysis.subjectSeed.box, width: 0.2 });
		editor.valid.set(false);
		f.submit();
		editor.valid.set(true);
		f.fixture.componentRef.setInput('recording', { ...recording, media: null });
		f.fixture.detectChanges();
		f.submit();
		f.fixture.componentRef.setInput('recording', recording);
		f.fixture.detectChanges();
		f.store.context.set(null);
		f.element
			.querySelector('form')
			?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		expect(f.store.correct).not.toHaveBeenCalled();
		f.fixture.detectChanges();
		expect(f.element.textContent).toContain('no unresolved tracking gap');
	});
	it('renders loading, read failure, pending, failure, and success accessibly', async () => {
		const f = await setup();
		f.store.context.set({ ...gap, frames: [] });
		f.fixture.detectChanges();
		expect(f.element.querySelector('[role=status]')?.textContent).toContain(
			'No later prepared frames',
		);
		f.store.context.set(gap);
		f.store.loading.set(true);
		f.fixture.detectChanges();
		expect(f.element.querySelector('[role=status]')?.textContent).toContain(
			'Loading',
		);
		f.store.loading.set(false);
		f.store.readFailed.set(true);
		f.fixture.detectChanges();
		expect(f.element.querySelector('[role=alert]')?.textContent).toContain(
			'could not be loaded',
		);
		f.store.readFailed.set(false);
		f.store.outcome.set({ status: 'pending' });
		f.fixture.detectChanges();
		expect(
			f.element.querySelector<HTMLButtonElement>('button[type=submit]')
				?.disabled,
		).toBe(true);
		f.store.outcome.set({ status: 'failed' });
		f.fixture.detectChanges();
		expect(f.element.querySelector('[role=alert]')?.textContent).toContain(
			'Retry the same frame',
		);
		f.store.outcome.set({ status: 'succeeded' });
		f.fixture.detectChanges();
		expect(f.element.querySelector('[role=status]')?.textContent).toContain(
			'accepted',
		);
	});
});
