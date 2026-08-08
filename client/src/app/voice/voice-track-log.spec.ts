import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CarRunsStore } from '../car/car-runs-store';
import { CarStore } from '../car/car-store';
import { VoiceLogStore } from './voice-log-store';
import type {
	PendingVoiceCapture,
	VoiceDraft,
	VoiceUpdate,
} from './voice.models';
import { VoiceRecorder } from './voice-recorder';
import { VoiceTrackLog } from './voice-track-log';

const emptyDraft: VoiceDraft = {
	setupChanges: [],
	problems: [],
	conditions: [],
	driveSessionNotes: [],
	consumables: [],
	unmappedNotes: [],
	unresolvedNotes: [],
};

const fact = {
	confidence: 'high' as const,
	needsReview: false,
	sourceText: 'spoken fact',
};

const fullDraft: VoiceDraft = {
	setupChanges: [
		{ ...fact, section: 'vehicle', field: 'rideHeight', value: 18 },
	],
	problems: [{ ...fact, text: 'Rear stepped out' }],
	conditions: [{ ...fact, field: 'track', value: 'Club clay' }],
	driveSessionNotes: [{ ...fact, text: 'Faster in sweepers' }],
	consumables: [
		{ ...fact, kind: 'tires', axle: 'both', details: 'Silver tires' },
		{ ...fact, kind: 'fluid', fluidArea: 'rear-shocks', notes: '35wt' },
		{ ...fact, kind: 'fluid', fluidArea: 'front-shocks' },
	],
	unmappedNotes: ['Motor sounded different'],
	unresolvedNotes: ['Spring color was unclear'],
};

const voiceUpdate = (overrides: Partial<VoiceUpdate> = {}): VoiceUpdate => ({
	id: 'voice-1',
	carId: 'car-1',
	driveSessionId: null,
	status: 'pending',
	contentType: 'audio/webm',
	fileName: 'voice.webm',
	byteSize: 5,
	audioUrl: null,
	transcript: 'The rear stepped out',
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

const localCapture = (): PendingVoiceCapture => ({
	id: 'local-1',
	ownerKey: 'owner@example.test',
	carId: 'car-1',
	driveSessionId: null,
	text: 'Queued note',
	contentType: 'text/plain',
	fileName: 'local.txt',
	createdAt: '2026-08-08T01:00:00.000Z',
	status: 'queued',
	error: null,
});

type InternalVoiceTrackLog = {
	startRecording(
		mode: { kind: 'capture' } | { kind: 'correction'; id: string },
	): Promise<void>;
	stopRecording(): Promise<void>;
	showTextFallback(): void;
	hideTextFallback(): void;
	applyTextCorrection(id: string): Promise<void>;
	hasUncertainty(update: VoiceUpdate): boolean;
	contextCar(update: VoiceUpdate): string;
	saveContext(update: VoiceUpdate): Promise<void>;
	confidenceLabel(confidence: string, needsReview: boolean): string;
};

describe('VoiceTrackLog', () => {
	let fixture: ComponentFixture<VoiceTrackLog>;
	let carStore: {
		loading: ReturnType<typeof signal<boolean>>;
		failure: ReturnType<
			typeof signal<{ message: string; retryable: boolean } | null>
		>;
		car: ReturnType<typeof signal<Record<string, unknown> | null>>;
		selectCar: ReturnType<typeof vi.fn>;
		retry: ReturnType<typeof vi.fn>;
	};
	let runsStore: {
		sessions: ReturnType<typeof signal<Array<Record<string, unknown>>>>;
		timezone: ReturnType<typeof signal<string>>;
		selectCar: ReturnType<typeof vi.fn>;
	};
	let voiceStore: {
		localCaptures: ReturnType<typeof signal<PendingVoiceCapture[]>>;
		updates: ReturnType<typeof signal<VoiceUpdate[]>>;
		cars: ReturnType<typeof signal<Array<Record<string, unknown>>>>;
		loading: ReturnType<typeof signal<boolean>>;
		readError: ReturnType<typeof signal<string>>;
		error: ReturnType<typeof signal<string>>;
		message: ReturnType<typeof signal<string>>;
		action: ReturnType<typeof signal<string | null>>;
		selectCar: ReturnType<typeof vi.fn>;
		retryQueued: ReturnType<typeof vi.fn>;
		retryRead: ReturnType<typeof vi.fn>;
		discardLocal: ReturnType<typeof vi.fn>;
		enqueueAudio: ReturnType<typeof vi.fn>;
		enqueueText: ReturnType<typeof vi.fn>;
		correctAudio: ReturnType<typeof vi.fn>;
		correctText: ReturnType<typeof vi.fn>;
		updateContext: ReturnType<typeof vi.fn>;
		process: ReturnType<typeof vi.fn>;
		confirm: ReturnType<typeof vi.fn>;
		discardServer: ReturnType<typeof vi.fn>;
	};
	let recorder: {
		checking: ReturnType<typeof signal<boolean>>;
		supported: ReturnType<typeof signal<boolean>>;
		starting: ReturnType<typeof signal<boolean>>;
		recording: ReturnType<typeof signal<boolean>>;
		elapsedSeconds: ReturnType<typeof signal<number>>;
		detectSupport: ReturnType<typeof vi.fn>;
		start: ReturnType<typeof vi.fn>;
		stop: ReturnType<typeof vi.fn>;
		cancel: ReturnType<typeof vi.fn>;
	};

	const car = (overrides: Record<string, unknown> = {}) => ({
		id: 'car-1',
		name: 'Buggy',
		make: 'Associated',
		model: 'B7',
		archivedAt: null,
		...overrides,
	});

	const internal = (): InternalVoiceTrackLog =>
		fixture.componentInstance as unknown as InternalVoiceTrackLog;

	const detect = async (): Promise<void> => {
		fixture.detectChanges();
		await fixture.whenStable();
		fixture.detectChanges();
	};

	const button = (label: string): HTMLButtonElement => {
		const match = [...fixture.nativeElement.querySelectorAll('button')].find(
			(value: HTMLButtonElement) => value.textContent?.trim().includes(label),
		) as HTMLButtonElement | undefined;
		if (!match) throw new Error(`Button not found: ${label}`);
		return match;
	};

	beforeEach(async () => {
		carStore = {
			loading: signal(false),
			failure: signal(null),
			car: signal(car()),
			selectCar: vi.fn(),
			retry: vi.fn(),
		};
		runsStore = {
			sessions: signal([
				{
					id: 'deleted-run',
					startedAt: '2026-08-07T01:00:00.000Z',
					conditions: null,
					deletedAt: '2026-08-08T00:00:00.000Z',
				},
				{
					id: 'drive-1',
					startedAt: '2026-08-08T01:00:00.000Z',
					conditions: 'Dry',
					deletedAt: null,
				},
			]),
			timezone: signal('UTC'),
			selectCar: vi.fn(),
		};
		voiceStore = {
			localCaptures: signal([]),
			updates: signal([]),
			cars: signal([car(), car({ id: 'car-2', name: 'Truck' })]),
			loading: signal(false),
			readError: signal(''),
			error: signal(''),
			message: signal(''),
			action: signal(null),
			selectCar: vi.fn(),
			retryQueued: vi.fn(async () => undefined),
			retryRead: vi.fn(),
			discardLocal: vi.fn(async () => undefined),
			enqueueAudio: vi.fn(async () => undefined),
			enqueueText: vi.fn(async () => undefined),
			correctAudio: vi.fn(async () => ({ voiceUpdate: voiceUpdate() })),
			correctText: vi.fn(async () => ({ voiceUpdate: voiceUpdate() })),
			updateContext: vi.fn(async () => ({ voiceUpdate: voiceUpdate() })),
			process: vi.fn(async () => ({ voiceUpdate: voiceUpdate() })),
			confirm: vi.fn(async () => ({ voiceUpdate: voiceUpdate() })),
			discardServer: vi.fn(async () => ({ voiceUpdate: voiceUpdate() })),
		};
		recorder = {
			checking: signal(false),
			supported: signal(true),
			starting: signal(false),
			recording: signal(false),
			elapsedSeconds: signal(0),
			detectSupport: vi.fn(async () => true),
			start: vi.fn(async () => undefined),
			stop: vi.fn(async () => new Blob(['voice'], { type: 'audio/webm' })),
			cancel: vi.fn(),
		};

		await TestBed.configureTestingModule({
			imports: [VoiceTrackLog],
			providers: [
				provideRouter([]),
				{ provide: CarStore, useValue: carStore },
				{ provide: CarRunsStore, useValue: runsStore },
				{ provide: VoiceLogStore, useValue: voiceStore },
				{ provide: VoiceRecorder, useValue: recorder },
			],
		}).compileComponents();
		fixture = TestBed.createComponent(VoiceTrackLog);
		fixture.componentRef.setInput('carId', 'car-1');
	});

	afterEach(() => {
		vi.restoreAllMocks();
		TestBed.resetTestingModule();
	});

	it('renders car, loading, failure, archive, and history read states', async () => {
		fixture.componentRef.setInput('carId', '');
		carStore.loading.set(true);
		await detect();
		expect(fixture.nativeElement.textContent).toContain(
			'Opening the car record',
		);
		internal().showTextFallback();
		await Promise.resolve();
		internal().hideTextFallback();
		fixture.componentRef.setInput('carId', 'car-1');

		carStore.loading.set(false);
		carStore.failure.set({ message: 'Car failed', retryable: true });
		await detect();
		button('Try again').click();
		expect(carStore.retry).toHaveBeenCalledOnce();

		carStore.failure.set({ message: 'Session expired', retryable: false });
		await detect();
		expect(
			fixture.nativeElement.querySelector('[role="alert"] button'),
		).toBeNull();

		carStore.failure.set(null);
		carStore.car.set(car());
		recorder.checking.set(true);
		voiceStore.loading.set(true);
		await detect();
		expect(fixture.nativeElement.textContent).toContain('Checking microphone');
		expect(fixture.nativeElement.textContent).toContain(
			'Opening voice history',
		);

		recorder.checking.set(false);
		voiceStore.loading.set(false);
		voiceStore.readError.set('History unavailable');
		await detect();
		button('Try again').click();
		expect(voiceStore.retryRead).toHaveBeenCalledOnce();

		voiceStore.readError.set('');
		voiceStore.error.set('Mutation failed');
		voiceStore.message.set('Mutation worked');
		await detect();
		expect(fixture.nativeElement.textContent).toContain('No voice notes yet');
		expect(fixture.nativeElement.textContent).toContain('Mutation failed');
		expect(fixture.nativeElement.textContent).toContain('Mutation worked');
		internal().showTextFallback();
		await Promise.resolve();
		expect(document.activeElement?.id).toBe('voice-history-title');
		internal().hideTextFallback();

		carStore.car.set(car({ make: null, manufacturer: 'Tamiya', model: null }));
		await detect();
		expect(fixture.nativeElement.textContent).toContain(
			'Tamiya · Model not recorded',
		);
		carStore.car.set(car({ make: null, manufacturer: null }));
		await detect();
		expect(fixture.nativeElement.textContent).toContain('Make not recorded');

		carStore.car.set(car({ archivedAt: '2026-08-08T00:00:00.000Z' }));
		await detect();
		expect(fixture.nativeElement.textContent).toContain('read-only');
	});

	it('supports microphone, text fallback, cancellation, and capture errors', async () => {
		await detect();
		expect(carStore.selectCar).toHaveBeenCalledWith('car-1');
		expect(runsStore.selectCar).toHaveBeenCalledWith('car-1');
		expect(voiceStore.selectCar).toHaveBeenCalledWith('car-1');
		expect(recorder.detectSupport).toHaveBeenCalledOnce();

		const select = fixture.nativeElement.querySelector(
			'#voice-drive-session',
		) as HTMLSelectElement;
		select.value = 'drive-1';
		select.dispatchEvent(new Event('change'));
		internal().showTextFallback();
		await detect();

		const note = fixture.nativeElement.querySelector(
			'#voice-text-note',
		) as HTMLTextAreaElement;
		note.value = '   ';
		note.dispatchEvent(new Event('input'));
		button('Keep text note').click();
		await detect();
		expect(fixture.nativeElement.textContent).toContain(
			'Describe the track note',
		);

		note.value = 'Rear stepped out';
		note.dispatchEvent(new Event('input'));
		button('Keep text note').click();
		await detect();
		expect(voiceStore.enqueueText).toHaveBeenCalledWith(
			'Rear stepped out',
			'drive-1',
		);

		button('Type instead').click();
		await detect();
		button('Use microphone').click();
		await detect();
		button('Start voice note').click();
		await detect();
		expect(fixture.nativeElement.textContent).toContain('Recording track note');
		await internal().startRecording({ kind: 'capture' });
		button('Cancel').click();
		await detect();
		expect(recorder.cancel).toHaveBeenCalledOnce();

		button('Start voice note').click();
		await detect();
		button('Stop and keep recording').click();
		await detect();
		expect(voiceStore.enqueueAudio).toHaveBeenCalledWith(
			expect.any(Blob),
			'drive-1',
		);

		runsStore.sessions.set([]);
		await detect();
		button('Start voice note').click();
		await detect();
		button('Stop and keep recording').click();
		await detect();
		expect(voiceStore.enqueueAudio).toHaveBeenLastCalledWith(
			expect.any(Blob),
			null,
		);
		internal().showTextFallback();
		await detect();
		const noteWithoutRun = fixture.nativeElement.querySelector(
			'#voice-text-note',
		) as HTMLTextAreaElement;
		noteWithoutRun.value = 'No run selected';
		noteWithoutRun.dispatchEvent(new Event('input'));
		button('Keep text note').click();
		await detect();
		expect(voiceStore.enqueueText).toHaveBeenLastCalledWith(
			'No run selected',
			null,
		);

		await internal().stopRecording();
		recorder.start.mockRejectedValueOnce(
			new DOMException('Denied', 'NotAllowedError'),
		);
		await internal().startRecording({ kind: 'capture' });
		expect(fixture.componentInstance).toBeTruthy();
		recorder.start.mockRejectedValueOnce(new Error('Recorder failed'));
		await internal().startRecording({ kind: 'capture' });
		recorder.start.mockRejectedValueOnce('unknown');
		await internal().startRecording({ kind: 'capture' });

		recorder.start.mockResolvedValue(undefined);
		await internal().startRecording({ kind: 'capture' });
		recorder.stop.mockRejectedValueOnce(new Error('Stop failed'));
		await internal().stopRecording();
		await internal().startRecording({ kind: 'capture' });
		recorder.stop.mockRejectedValueOnce('unknown');
		await internal().stopRecording();

		recorder.supported.set(false);
		await detect();
		expect(
			fixture.nativeElement.querySelector('#voice-text-note'),
		).toBeTruthy();
		internal().hideTextFallback();
	});

	it('distinguishes microphone startup from live recording and shows elapsed time', async () => {
		let resolveStart: (() => void) | undefined;
		recorder.start.mockImplementationOnce(() => {
			recorder.starting.set(true);
			return new Promise<void>((resolve) => {
				resolveStart = resolve;
			});
		});
		await detect();

		const starting = internal().startRecording({ kind: 'capture' });
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Starting microphone');
		expect(fixture.nativeElement.querySelector('.recording-timer')).toBeNull();
		expect(
			[...fixture.nativeElement.querySelectorAll('button')].some(
				(value: HTMLButtonElement) =>
					value.textContent?.includes('Stop and keep recording'),
			),
		).toBe(false);

		recorder.starting.set(false);
		recorder.recording.set(true);
		recorder.elapsedSeconds.set(3);
		resolveStart?.();
		await starting;
		await detect();
		expect(fixture.nativeElement.textContent).toContain('Recording track note');
		expect(
			fixture.nativeElement.querySelector('.recording-timer')?.textContent,
		).toContain('0:03');
		expect(button('Stop and keep recording')).toBeTruthy();

		recorder.elapsedSeconds.set(61);
		await detect();
		const timer = fixture.nativeElement.querySelector('.recording-timer');
		expect(timer?.textContent).toContain('1:01');
		expect(timer?.getAttribute('aria-label')).toBe(
			'Elapsed recording time: 1 minute, 1 second',
		);
	});

	it('renders and controls local, pending, failed, and processing notes', async () => {
		runsStore.sessions.set([
			{
				id: 'drive-1',
				startedAt: '2026-08-08T01:00:00.000Z',
				conditions: null,
				deletedAt: null,
			},
		]);
		voiceStore.localCaptures.set([localCapture()]);
		voiceStore.updates.set([
			voiceUpdate({
				id: 'pending',
				audioUrl: '/audio/pending',
				error: 'Previous processing failed',
			}),
			voiceUpdate({ id: 'failed', status: 'failed', transcript: null }),
			voiceUpdate({ id: 'processing', status: 'processing' }),
		]);
		await detect();
		expect(fixture.nativeElement.textContent).toContain(
			'Pending on this device',
		);
		expect(fixture.nativeElement.textContent).toContain('Retry processing');
		expect(fixture.nativeElement.textContent).toContain('Transcribing');
		button('Retry now').click();
		button('Discard local recording').click();
		expect(voiceStore.retryQueued).toHaveBeenCalled();
		expect(voiceStore.discardLocal).toHaveBeenCalledWith('local-1');

		const context = fixture.nativeElement.querySelector(
			'#context-car-pending',
		) as HTMLSelectElement;
		context.value = 'car-2';
		context.dispatchEvent(new Event('change'));
		await detect();
		expect(internal().contextCar(voiceUpdate({ id: 'pending' }))).toBe('car-2');
		const navigate = vi
			.spyOn(TestBed.inject(Router), 'navigate')
			.mockResolvedValue(true);
		button('Update context').click();
		await fixture.whenStable();
		expect(voiceStore.updateContext).toHaveBeenCalledWith(
			'pending',
			'car-2',
			null,
		);
		expect(navigate).toHaveBeenCalledWith(['/garage', 'car-2', 'voice']);

		voiceStore.updateContext.mockResolvedValueOnce(null);
		await internal().saveContext(voiceUpdate({ id: 'same-car' }));
		runsStore.sessions.set([]);
		await detect();
		await internal().saveContext(voiceUpdate({ id: 'same-car-no-run' }));
		expect(internal().contextCar(voiceUpdate({ id: 'unmapped' }))).toBe(
			'car-1',
		);

		button('Process note').click();
		button('Discard recording').click();
		expect(voiceStore.process).toHaveBeenCalledWith('pending');
		expect(voiceStore.discardServer).toHaveBeenCalledWith('pending', false);

		voiceStore.action.set('busy');
		await detect();
		expect(
			fixture.nativeElement.querySelector('button[disabled]'),
		).toBeTruthy();
		window.dispatchEvent(new Event('online'));
		expect(voiceStore.retryQueued).toHaveBeenCalled();
	});

	it('reviews extracted facts, uncertainty, and text or voice corrections', async () => {
		const uncertain = voiceUpdate({
			id: 'review',
			status: 'needs-review',
			audioUrl: '/audio/review',
			draft: fullDraft,
			clarificationPrompt: 'Which axle?',
		});
		voiceStore.updates.set([uncertain]);
		await detect();
		const text = fixture.nativeElement.textContent;
		expect(text).toContain('Club clay');
		expect(text).toContain('Motor sounded different');
		expect(text).toContain('Spring color was unclear');
		button('Keep uncertain wording').click();
		expect(voiceStore.confirm).toHaveBeenCalledWith('review', true);

		button('Correct or answer').click();
		await detect();
		const correction = fixture.nativeElement.querySelector(
			'#correction-review',
		) as HTMLInputElement;
		correction.value = '   ';
		correction.dispatchEvent(new Event('input'));
		button('Apply correction').click();
		await detect();
		expect(fixture.nativeElement.textContent).toContain('Say or type');

		correction.value = 'Rear diff, not front';
		correction.dispatchEvent(new Event('input'));
		button('Apply correction').click();
		await fixture.whenStable();
		expect(voiceStore.correctText).toHaveBeenCalledWith(
			'review',
			'Rear diff, not front',
		);

		button('Correct or answer').click();
		await detect();
		recorder.supported.set(false);
		await detect();
		expect(fixture.nativeElement.textContent).not.toContain('Speak correction');
		recorder.supported.set(true);
		await detect();
		button('Speak correction').click();
		await detect();
		expect(fixture.nativeElement.textContent).toContain('Recording correction');
		button('Stop and keep recording').click();
		await fixture.whenStable();
		await detect();
		expect(voiceStore.correctAudio).toHaveBeenCalledWith(
			'review',
			expect.any(Blob),
		);

		button('Cancel').click();
		await detect();
		voiceStore.correctText.mockResolvedValueOnce(null);
		button('Correct or answer').click();
		await detect();
		const nextCorrection = fixture.nativeElement.querySelector(
			'#correction-review',
		) as HTMLInputElement;
		nextCorrection.value = 'Keep form open';
		nextCorrection.dispatchEvent(new Event('input'));
		await internal().applyTextCorrection('review');

		const certain = voiceUpdate({
			id: 'certain',
			status: 'needs-review',
			draft: emptyDraft,
		});
		voiceStore.updates.set([certain]);
		await detect();
		button('Confirm and save').click();
		expect(voiceStore.confirm).toHaveBeenCalledWith('certain', false);

		expect(internal().hasUncertainty(voiceUpdate({ draft: null }))).toBe(false);
		for (const draft of [
			{ ...emptyDraft, unresolvedNotes: ['unclear'] },
			{
				...emptyDraft,
				setupChanges: [
					{
						...fact,
						section: 'vehicle' as const,
						field: 'x',
						value: 1,
						needsReview: true,
					},
				],
			},
			{ ...emptyDraft, problems: [{ ...fact, text: 'x', needsReview: true }] },
			{
				...emptyDraft,
				conditions: [
					{ ...fact, field: 'track' as const, value: 'x', needsReview: true },
				],
			},
			{
				...emptyDraft,
				driveSessionNotes: [{ ...fact, text: 'x', needsReview: true }],
			},
			{
				...emptyDraft,
				consumables: [
					{
						...fact,
						kind: 'tires' as const,
						axle: 'both' as const,
						needsReview: true,
					},
				],
			},
		])
			expect(internal().hasUncertainty(voiceUpdate({ draft }))).toBe(true);
		expect(internal().hasUncertainty(certain)).toBe(false);
		expect(internal().confidenceLabel('low', true)).toContain('review');
		expect(internal().confidenceLabel('high', false)).toBe('high confidence');
	});

	it('keeps saved provenance and artifact deletion consequences visible', async () => {
		voiceStore.updates.set([
			voiceUpdate({
				id: 'saved-audio',
				status: 'saved',
				audioUrl: '/audio/saved',
				results: [
					{
						id: 'result-1',
						kind: 'setup',
						recordId: 'setup-1',
						label: 'New setup snapshot',
						url: '/garage/car-1/setups',
						createdAt: '2026-08-08T01:00:00.000Z',
					},
				],
				corrections: [
					{
						id: 'correction-audio',
						kind: 'voice',
						transcript: 'Rear, not front',
						audioUrl: '/audio/correction',
						createdAt: '2026-08-08T01:00:00.000Z',
					},
					{
						id: 'correction-text',
						kind: 'text',
						transcript: '7k fluid',
						audioUrl: null,
						createdAt: '2026-08-08T01:00:00.000Z',
					},
				],
			}),
			voiceUpdate({
				id: 'saved-deleted',
				status: 'saved',
				transcript: null,
				draft: null,
				artifactDeletedAt: '2026-08-08T02:00:00.000Z',
			}),
			voiceUpdate({
				id: 'saved-text',
				status: 'saved',
				transcript: null,
				draft: null,
			}),
			voiceUpdate({ id: 'discarded', status: 'discarded', draft: null }),
		]);
		await detect();
		expect(fixture.nativeElement.textContent).toContain(
			'Discarded voice update',
		);
		expect(fixture.nativeElement.textContent).toContain('New setup snapshot');
		expect(fixture.nativeElement.textContent).toContain(
			'Correction provenance',
		);
		expect(fixture.nativeElement.textContent).toContain(
			'Original audio was removed',
		);
		button('Remove original audio').click();
		expect(voiceStore.discardServer).toHaveBeenCalledWith('saved-audio', true);
	});
});
