import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CarStore } from '../car/car-store';
import { DRIVE_SESSION_CONTEXT } from '../car/drive-sessions/drive-session-context';
import type {
	PendingVoiceCapture,
	VoiceDraft,
	VoiceOperationOutcome,
	VoiceRecordingMode,
	VoiceUpdate,
} from './voice.models';
import { VoiceLogStore } from './voice-log-store';
import { VoiceNoteWorkspace } from './voice-note-workspace';
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

const idleOutcome = (): VoiceOperationOutcome => ({
	status: 'idle',
	operation: null,
	operationId: null,
});

type WorkspaceInternal = {
	showTextFallback(): void;
	hideTextFallback(): void;
	startRecording(mode: VoiceRecordingMode): void;
	stopRecording(): void;
	cancelRecording(): void;
	submitTextNote(): void;
	beginCorrection(id: string): void;
	cancelCorrection(): void;
	applyTextCorrection(id: string): void;
	contextCar(update: VoiceUpdate): string;
	saveContext(update: VoiceUpdate): void;
	hasUncertainty(update: VoiceUpdate): boolean;
	confidenceLabel(
		confidence: 'high' | 'medium' | 'low',
		review: boolean,
	): string;
};

describe('VoiceNoteWorkspace', () => {
	let fixture: ComponentFixture<VoiceNoteWorkspace>;
	let driveSessionContext: {
		sessions: ReturnType<typeof signal<Array<Record<string, unknown>>>>;
		timezone: ReturnType<typeof signal<string>>;
		selectCar: ReturnType<typeof vi.fn>;
	};
	let store: {
		localCaptures: ReturnType<typeof signal<PendingVoiceCapture[]>>;
		updates: ReturnType<typeof signal<VoiceUpdate[]>>;
		cars: ReturnType<
			typeof signal<
				Array<{ id: string; name: string; archivedAt: string | null }>
			>
		>;
		loading: ReturnType<typeof signal<boolean>>;
		readError: ReturnType<typeof signal<string>>;
		error: ReturnType<typeof signal<string>>;
		message: ReturnType<typeof signal<string>>;
		pending: ReturnType<typeof signal<boolean>>;
		outcome: ReturnType<typeof signal<VoiceOperationOutcome>>;
		recorderError: ReturnType<typeof signal<string>>;
		recordingMode: ReturnType<typeof signal<VoiceRecordingMode | null>>;
		checking: ReturnType<typeof signal<boolean>>;
		supported: ReturnType<typeof signal<boolean>>;
		starting: ReturnType<typeof signal<boolean>>;
		recording: ReturnType<typeof signal<boolean>>;
		elapsedSeconds: ReturnType<typeof signal<number>>;
		inputLevel: ReturnType<typeof signal<number>>;
		audioDetected: ReturnType<typeof signal<boolean>>;
		inputMuted: ReturnType<typeof signal<boolean>>;
		selectCar: ReturnType<typeof vi.fn>;
		retryQueued: ReturnType<typeof vi.fn>;
		detectRecorderSupport: ReturnType<typeof vi.fn>;
		startRecording: ReturnType<typeof vi.fn>;
		stopRecording: ReturnType<typeof vi.fn>;
		cancelRecording: ReturnType<typeof vi.fn>;
		captureText: ReturnType<typeof vi.fn>;
		correctText: ReturnType<typeof vi.fn>;
		updateContext: ReturnType<typeof vi.fn>;
		process: ReturnType<typeof vi.fn>;
		confirm: ReturnType<typeof vi.fn>;
		discardLocal: ReturnType<typeof vi.fn>;
		discardServer: ReturnType<typeof vi.fn>;
		retryRead: ReturnType<typeof vi.fn>;
	};

	const internal = (): WorkspaceInternal =>
		fixture.componentInstance as unknown as WorkspaceInternal;

	const detect = async (): Promise<HTMLElement> => {
		fixture.detectChanges();
		await fixture.whenStable();
		fixture.detectChanges();
		return fixture.nativeElement as HTMLElement;
	};

	const button = (label: string): HTMLButtonElement => {
		const match = [...fixture.nativeElement.querySelectorAll('button')].find(
			(value: HTMLButtonElement) => value.textContent?.trim().includes(label),
		) as HTMLButtonElement | undefined;
		if (!match) throw new Error(`Button not found: ${label}`);
		return match;
	};

	beforeEach(async () => {
		driveSessionContext = {
			sessions: signal([
				{
					id: 'deleted',
					startedAt: '2026-08-07T01:00:00.000Z',
					conditions: null,
					deletedAt: 'now',
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
		store = {
			localCaptures: signal([]),
			updates: signal([]),
			cars: signal([
				{ id: 'car-1', name: 'Buggy', archivedAt: null },
				{ id: 'car-2', name: 'Truck', archivedAt: null },
			]),
			loading: signal(false),
			readError: signal(''),
			error: signal(''),
			message: signal(''),
			pending: signal(false),
			outcome: signal(idleOutcome()),
			recorderError: signal(''),
			recordingMode: signal(null),
			checking: signal(false),
			supported: signal(true),
			starting: signal(false),
			recording: signal(false),
			elapsedSeconds: signal(0),
			inputLevel: signal(0),
			audioDetected: signal(false),
			inputMuted: signal(false),
			selectCar: vi.fn(),
			retryQueued: vi.fn(),
			detectRecorderSupport: vi.fn(),
			startRecording: vi.fn((mode: VoiceRecordingMode) =>
				store.recordingMode.set(mode),
			),
			stopRecording: vi.fn(),
			cancelRecording: vi.fn(() => store.recordingMode.set(null)),
			captureText: vi.fn(),
			correctText: vi.fn(),
			updateContext: vi.fn(),
			process: vi.fn(),
			confirm: vi.fn(),
			discardLocal: vi.fn(),
			discardServer: vi.fn(),
			retryRead: vi.fn(),
		};
		await TestBed.configureTestingModule({
			imports: [VoiceNoteWorkspace],
			providers: [
				provideRouter([]),
				{ provide: DRIVE_SESSION_CONTEXT, useValue: driveSessionContext },
				{ provide: VoiceLogStore, useValue: store },
			],
		}).compileComponents();
		fixture = TestBed.createComponent(VoiceNoteWorkspace);
		fixture.componentRef.setInput('carId', 'car-1');
	});

	afterEach(() => {
		vi.restoreAllMocks();
		TestBed.resetTestingModule();
	});

	it('renders capture first, selects route context, and preserves no-setup independence', async () => {
		fixture.componentRef.setInput('carId', '');
		await detect();
		fixture.componentRef.setInput('carId', 'car-1');
		driveSessionContext.sessions.update((sessions) =>
			sessions.map((session) =>
				session['id'] === 'drive-1'
					? { ...session, conditions: null }
					: session,
			),
		);
		let root = await detect();
		expect(root.textContent).toContain('Voice note');
		expect(root.textContent).toContain('Start voice note');
		expect(root.textContent).not.toContain('Voice note history');
		expect(driveSessionContext.selectCar).toHaveBeenCalledWith('car-1');
		expect(store.selectCar).toHaveBeenCalledWith('car-1');
		expect(store.retryQueued).not.toHaveBeenCalled();
		expect(store.detectRecorderSupport).toHaveBeenCalledOnce();
		expect(
			root.querySelectorAll<HTMLSelectElement>('#voice-drive-session option'),
		).toHaveLength(2);
		store.readError.set('History unavailable');
		root = await detect();
		expect(root.textContent).toContain('History unavailable');
		store.readError.set('');
		store.message.set('Voice update saved to garage history.');
		root = await detect();
		expect(root.textContent).toContain('Voice update saved');
		expect(root.textContent).not.toContain('No voice notes yet');
		store.message.set('');

		fixture.componentRef.setInput('showHistory', true);
		root = await detect();
		expect(root.textContent).toContain('No voice notes yet');
		fixture.componentRef.setInput('archived', true);
		root = await detect();
		expect(root.textContent).toContain('read-only');
		expect(root.textContent).not.toContain('Start voice note');
	});

	it('dispatches text, recording, cancellation, and drive-session commands synchronously', async () => {
		let root = await detect();
		const select = root.querySelector(
			'#voice-drive-session',
		) as HTMLSelectElement;
		select.value = 'drive-1';
		select.dispatchEvent(new Event('change'));
		button('Type instead').click();
		root = await detect();
		const textarea = root.querySelector(
			'#voice-text-note',
		) as HTMLTextAreaElement;
		expect(document.activeElement).toBe(textarea);
		button('Keep text note').click();
		root = await detect();
		expect(root.textContent).toContain('Describe the track note');
		expect(document.activeElement).toBe(textarea);
		expect(store.captureText).not.toHaveBeenCalled();
		textarea.value = 'Rear stepped out';
		textarea.dispatchEvent(new Event('input'));
		button('Keep text note').click();
		expect(store.captureText).toHaveBeenCalledWith({
			text: 'Rear stepped out',
			driveSessionId: 'drive-1',
		});
		button('Use microphone').click();
		root = await detect();
		expect(root.querySelector('#voice-text-note')).toBeNull();

		button('Start voice note').click();
		expect(store.startRecording).toHaveBeenCalledWith({ kind: 'capture' });
		root = await detect();
		expect(root.textContent).toContain('Recording voice note');
		button('Stop and keep recording').click();
		expect(store.stopRecording).toHaveBeenCalledWith({
			driveSessionId: 'drive-1',
		});
		button('Cancel').click();
		expect(store.cancelRecording).toHaveBeenCalledOnce();

		driveSessionContext.sessions.set([]);
		store.recordingMode.set({ kind: 'capture' });
		await detect();
		button('Stop and keep recording').click();
		expect(store.stopRecording).toHaveBeenLastCalledWith({
			driveSessionId: null,
		});
		store.recordingMode.set(null);
		internal().showTextFallback();
		root = await detect();
		const noSessionNote = root.querySelector(
			'#voice-text-note',
		) as HTMLTextAreaElement;
		noSessionNote.value = 'No session';
		noSessionNote.dispatchEvent(new Event('input'));
		button('Keep text note').click();
		expect(store.captureText).toHaveBeenLastCalledWith({
			text: 'No session',
			driveSessionId: null,
		});
	});

	it('shows checking, startup, live meter, timer, and textual microphone status', async () => {
		store.recorderError.set('Microphone failed');
		let root = await detect();
		expect(root.textContent).toContain('Microphone failed');
		store.recorderError.set('');
		store.checking.set(true);
		root = await detect();
		expect(root.textContent).toContain('Checking microphone support');
		store.checking.set(false);
		store.recordingMode.set({ kind: 'capture' });
		store.starting.set(true);
		root = await detect();
		expect(root.textContent).toContain('Starting microphone');
		expect(root.textContent).not.toContain('Stop and keep recording');

		store.starting.set(false);
		store.elapsedSeconds.set(61);
		root = await detect();
		expect(root.textContent).toContain('Speak to test the microphone');
		const timer = root.querySelector('[role="timer"]');
		expect(timer?.textContent).toContain('1:01');
		expect(timer?.getAttribute('aria-label')).toBe(
			'Elapsed recording time: 1 minute, 1 second',
		);
		store.audioDetected.set(true);
		root = await detect();
		expect(root.textContent).toContain('Audio detected');
		store.inputMuted.set(true);
		root = await detect();
		expect(root.textContent).toContain('Microphone muted');

		store.recordingMode.set(null);
		store.supported.set(false);
		root = await detect();
		expect(root.querySelector('#voice-text-note')).toBeTruthy();
	});

	it('reacts to typed outcomes with focus, reset, fallback, and overview navigation', async () => {
		const navigate = vi
			.spyOn(TestBed.inject(Router), 'navigate')
			.mockResolvedValue(true);
		await detect();
		internal().showTextFallback();
		await Promise.resolve();
		internal().hideTextFallback();
		internal().beginCorrection('voice-1');
		store.outcome.set({
			status: 'failed',
			operation: 'start-recording',
			operationId: 1,
			subjectId: null,
			error: { kind: 'recording', message: 'Denied' },
		});
		await detect();
		expect(
			fixture.nativeElement.querySelector('#voice-text-note'),
		).toBeTruthy();
		expect(document.activeElement?.id).toBe('voice-text-note');
		store.outcome.set({
			status: 'failed',
			operation: 'confirm',
			operationId: 7,
			subjectId: 'voice-1',
			error: { kind: 'unavailable' },
		});
		await detect();

		store.localCaptures.set([localCapture()]);
		store.outcome.set({
			status: 'succeeded',
			operation: 'capture-text',
			operationId: 2,
			subjectId: 'local-1',
			update: null,
			destinationCarId: null,
		});
		await detect();
		await Promise.resolve();
		expect(document.activeElement?.id).toBe('voice-review-title');

		store.outcome.set({
			status: 'succeeded',
			operation: 'correct-text',
			operationId: 3,
			subjectId: 'voice-1',
			update: voiceUpdate(),
			destinationCarId: null,
		});
		await detect();
		store.outcome.set({
			status: 'succeeded',
			operation: 'correct-audio',
			operationId: 4,
			subjectId: 'voice-1',
			update: voiceUpdate(),
			destinationCarId: null,
		});
		await detect();

		store.outcome.set({
			status: 'succeeded',
			operation: 'update-context',
			operationId: 5,
			subjectId: 'voice-1',
			update: voiceUpdate({ carId: 'car-2' }),
			destinationCarId: 'car-2',
		});
		await detect();
		expect(navigate).toHaveBeenCalledWith(['/garage', 'car-2', 'overview']);

		store.outcome.set({
			status: 'succeeded',
			operation: 'update-context',
			operationId: 6,
			subjectId: 'voice-1',
			update: voiceUpdate(),
			destinationCarId: 'car-1',
		});
		await detect();
		expect(navigate).toHaveBeenCalledOnce();
		window.dispatchEvent(new Event('online'));
		expect(store.retryQueued).toHaveBeenCalled();
	});

	it('renders local, pending, failed, processing, and feedback states', async () => {
		fixture.componentRef.setInput('showHistory', true);
		store.localCaptures.set([localCapture()]);
		store.updates.set([
			voiceUpdate({
				id: 'pending',
				audioUrl: '/audio/pending',
				error: 'Failed',
			}),
			voiceUpdate({ id: 'failed', status: 'failed', transcript: null }),
			voiceUpdate({ id: 'processing', status: 'processing' }),
		]);
		store.error.set('Mutation failed');
		store.message.set('Mutation worked');
		let root = await detect();
		expect(root.textContent).toContain('Pending on this device');
		expect(root.textContent).toContain('Retry processing');
		expect(root.textContent).toContain('Transcribing');
		expect(root.textContent).toContain('Mutation failed');
		expect(root.textContent).toContain('Mutation worked');
		button('Retry now').click();
		button('Discard local recording').click();
		expect(store.discardLocal).toHaveBeenCalledWith('local-1');

		const context = root.querySelector(
			'#context-car-pending',
		) as HTMLSelectElement;
		context.value = 'car-2';
		context.dispatchEvent(new Event('change'));
		await detect();
		expect(internal().contextCar(voiceUpdate({ id: 'pending' }))).toBe('car-2');
		button('Update context').click();
		expect(store.updateContext).toHaveBeenCalledWith({
			id: 'pending',
			carId: 'car-2',
			driveSessionId: null,
		});
		expect(internal().contextCar(voiceUpdate({ id: 'unmapped' }))).toBe(
			'car-1',
		);
		internal().saveContext(voiceUpdate({ id: 'same-car' }));
		expect(store.updateContext).toHaveBeenLastCalledWith({
			id: 'same-car',
			carId: 'car-1',
			driveSessionId: 'drive-1',
		});
		driveSessionContext.sessions.set([]);
		await detect();
		internal().saveContext(voiceUpdate({ id: 'same-car-no-session' }));
		expect(store.updateContext).toHaveBeenLastCalledWith({
			id: 'same-car-no-session',
			carId: 'car-1',
			driveSessionId: null,
		});
		button('Process note').click();
		button('Discard recording').click();
		expect(store.process).toHaveBeenCalledWith('pending');
		expect(store.discardServer).toHaveBeenCalledWith('pending', false);

		store.loading.set(true);
		root = await detect();
		expect(root.textContent).toContain('Opening voice history');
		store.loading.set(false);
		store.readError.set('History unavailable');
		root = await detect();
		button('Try again').click();
		expect(store.retryRead).toHaveBeenCalledOnce();
		store.pending.set(true);
		store.readError.set('');
		root = await detect();
		expect(root.querySelector('button[disabled]')).toBeTruthy();
	});

	it('keeps transcript beside every proposed fact and requires explicit confirmation', async () => {
		store.updates.set([
			voiceUpdate({
				id: 'review',
				status: 'needs-review',
				audioUrl: '/audio/review',
				transcript: null,
				draft: {
					...fullDraft,
					consumables: [...fullDraft.consumables, { ...fact, kind: 'fluid' }],
				},
				clarificationPrompt: 'Which axle?',
			}),
		]);
		let root = await detect();
		expect(
			root.querySelector('[aria-label="Transcript"]')?.textContent,
		).toContain('No transcript was retained');
		const proposed = root.querySelector(
			'[aria-label="Proposed garage records"]',
		);
		expect(proposed?.textContent).toContain('Proposed Setup change');
		expect(proposed?.textContent).toContain('Club clay');
		expect(proposed?.textContent).toContain('Motor sounded different');
		expect(proposed?.textContent).toContain('Spring color was unclear');
		expect(root.textContent).not.toMatch(/recommend|try next|you should/i);
		button('Keep uncertain wording').click();
		expect(store.confirm).toHaveBeenCalledWith('review', true);

		button('Correct or answer').click();
		root = await detect();
		const correction = root.querySelector(
			'#correction-review',
		) as HTMLInputElement;
		button('Apply correction').click();
		root = await detect();
		expect(root.textContent).toContain('Say or type the correction');
		expect(document.activeElement).toBe(correction);
		expect(store.correctText).not.toHaveBeenCalled();
		correction.value = 'Rear diff, not front';
		correction.dispatchEvent(new Event('input'));
		button('Apply correction').click();
		expect(store.correctText).toHaveBeenCalledWith({
			id: 'review',
			text: 'Rear diff, not front',
		});
		store.supported.set(false);
		root = await detect();
		expect(root.textContent).not.toContain('Speak correction');
		store.supported.set(true);
		await detect();
		button('Speak correction').click();
		expect(store.startRecording).toHaveBeenCalledWith({
			kind: 'correction',
			id: 'review',
		});
		root = await detect();
		expect(root.textContent).toContain('Recording correction');
		button('Cancel').click();
		root = await detect();
		button('Cancel').click();

		store.updates.set([
			voiceUpdate({ id: 'certain', status: 'needs-review', draft: emptyDraft }),
		]);
		root = await detect();
		button('Confirm and save').click();
		expect(store.confirm).toHaveBeenCalledWith('certain', false);
		expect(internal().hasUncertainty(voiceUpdate({ draft: null }))).toBe(false);
		expect(internal().confidenceLabel('low', true)).toContain('review');
		expect(internal().confidenceLabel('high', false)).toBe('high confidence');
	});

	it('keeps full saved provenance secondary to selected-car capture', async () => {
		store.updates.set([
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
						createdAt: 'now',
					},
				],
				corrections: [
					{
						id: 'correction-audio',
						kind: 'voice',
						transcript: 'Rear, not front',
						audioUrl: '/audio/correction',
						createdAt: 'now',
					},
					{
						id: 'correction-text',
						kind: 'text',
						transcript: '35 wt',
						audioUrl: null,
						createdAt: 'now',
					},
				],
			}),
			voiceUpdate({
				id: 'saved-deleted',
				status: 'saved',
				audioUrl: null,
				artifactDeletedAt: 'now',
			}),
			voiceUpdate({ id: 'discarded', status: 'discarded', draft: null }),
		]);
		let root = await detect();
		expect(root.textContent).not.toContain('Saved voice update');
		fixture.componentRef.setInput('showHistory', true);
		root = await detect();
		expect(root.textContent).toContain('Saved voice update');
		expect(root.textContent).toContain('Discarded voice update');
		expect(root.textContent).toContain('New setup snapshot');
		expect(root.textContent).toContain('Correction provenance');
		expect(root.textContent).toContain('Original audio was removed');
		button('Remove original audio').click();
		expect(store.discardServer).toHaveBeenCalledWith('saved-audio', true);
	});
});

describe('VoiceTrackLog route', () => {
	afterEach(() => TestBed.resetTestingModule());

	it('owns car loading, retry, terminal failure, and selected route shell', async () => {
		const carStore = {
			loading: signal(true),
			failure: signal<{ message: string; retryable: boolean } | null>(null),
			car: signal<Record<string, unknown> | null>(null),
			selectCar: vi.fn(),
			retry: vi.fn(),
		};
		const workspaceStore = {
			localCaptures: signal([]),
			updates: signal([]),
			cars: signal([]),
			loading: signal(false),
			readError: signal(''),
			error: signal(''),
			message: signal(''),
			pending: signal(false),
			outcome: signal(idleOutcome()),
			recorderError: signal(''),
			recordingMode: signal(null),
			checking: signal(false),
			supported: signal(true),
			starting: signal(false),
			recording: signal(false),
			elapsedSeconds: signal(0),
			inputLevel: signal(0),
			audioDetected: signal(false),
			inputMuted: signal(false),
			selectCar: vi.fn(),
			retryQueued: vi.fn(),
			detectRecorderSupport: vi.fn(),
			startRecording: vi.fn(),
			stopRecording: vi.fn(),
			cancelRecording: vi.fn(),
			captureText: vi.fn(),
			correctText: vi.fn(),
			updateContext: vi.fn(),
			process: vi.fn(),
			confirm: vi.fn(),
			discardLocal: vi.fn(),
			discardServer: vi.fn(),
			retryRead: vi.fn(),
		};
		await TestBed.configureTestingModule({
			imports: [VoiceTrackLog],
			providers: [
				provideRouter([]),
				{ provide: CarStore, useValue: carStore },
				{ provide: VoiceLogStore, useValue: workspaceStore },
				{
					provide: DRIVE_SESSION_CONTEXT,
					useValue: {
						sessions: signal([]),
						timezone: signal('UTC'),
						selectCar: vi.fn(),
					},
				},
			],
		}).compileComponents();
		const fixture = TestBed.createComponent(VoiceTrackLog);
		fixture.componentRef.setInput('carId', '');
		fixture.detectChanges();
		fixture.componentRef.setInput('carId', 'car-1');
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Opening the car record',
		);
		expect(carStore.selectCar).toHaveBeenCalledWith('car-1');

		carStore.loading.set(false);
		carStore.failure.set({ message: 'Car failed', retryable: true });
		fixture.detectChanges();
		(
			fixture.nativeElement.querySelector('button') as HTMLButtonElement
		).click();
		expect(carStore.retry).toHaveBeenCalledOnce();
		carStore.failure.set({ message: 'Expired', retryable: false });
		fixture.detectChanges();
		expect(
			fixture.nativeElement.querySelector('[role="alert"] button'),
		).toBeNull();

		carStore.failure.set(null);
		carStore.car.set({ id: 'car-1', name: 'Buggy', archivedAt: null });
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Voice note history');
	});
});
