import { DatePipe, DOCUMENT } from '@angular/common';
import {
	Component,
	computed,
	effect,
	inject,
	input,
	linkedSignal,
	signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { CarRunsStore } from '../car/car-runs-store';
import { CarSectionShell } from '../car/car-section-shell';
import { CarStore } from '../car/car-store';
import type { VoiceUpdate } from './voice.models';
import { VoiceLogStore } from './voice-log-store';
import { VoiceRecorder } from './voice-recorder';

type RecordingMode = { kind: 'capture' } | { kind: 'correction'; id: string };

@Component({
	selector: 'app-voice-track-log',
	imports: [CarSectionShell, DatePipe, RouterLink],
	templateUrl: './voice-track-log.html',
	styleUrl: './voice-track-log.css',
	host: { '(window:online)': 'retryQueued()' },
})
export class VoiceTrackLog {
	readonly carId = input('');
	protected readonly carStore = inject(CarStore);
	protected readonly runsStore = inject(CarRunsStore);
	protected readonly voiceStore = inject(VoiceLogStore);
	protected readonly recorder = inject(VoiceRecorder);
	private readonly router = inject(Router);
	private readonly document = inject(DOCUMENT);
	protected readonly recordingMode = signal<RecordingMode | null>(null);
	protected readonly recorderError = signal('');
	protected readonly textFallback = signal(false);
	protected readonly textNote = signal('');
	protected readonly correctionText = signal('');
	protected readonly correctingId = signal<string | null>(null);
	protected readonly contextCars = signal<Record<string, string>>({});
	protected readonly selectedDriveId = linkedSignal(
		() =>
			this.runsStore.sessions().find((session) => !session.deletedAt)?.id ?? '',
	);
	protected readonly hasHistory = computed(
		() =>
			this.voiceStore.localCaptures().length > 0 ||
			this.voiceStore.updates().length > 0,
	);

	constructor() {
		effect(() => {
			const carId = this.carId();
			if (!carId) return;
			this.carStore.selectCar(carId);
			this.runsStore.selectCar(carId);
			this.voiceStore.selectCar(carId);
			void this.voiceStore.retryQueued();
		});
		void this.recorder.detectSupport();
	}

	protected setDriveSession(event: Event): void {
		this.selectedDriveId.set((event.currentTarget as HTMLSelectElement).value);
	}

	protected showTextFallback(): void {
		this.textFallback.set(true);
		this.focusHistory();
	}

	protected hideTextFallback(): void {
		this.textFallback.set(false);
		this.textNote.set('');
	}

	protected updateTextNote(event: Event): void {
		this.textNote.set((event.currentTarget as HTMLTextAreaElement).value);
	}

	protected updateCorrection(event: Event): void {
		this.correctionText.set((event.currentTarget as HTMLInputElement).value);
	}

	protected async startRecording(mode: RecordingMode): Promise<void> {
		if (this.recordingMode()) return;
		this.recorderError.set('');
		try {
			await this.recorder.start();
			this.recordingMode.set(mode);
		} catch (error) {
			this.recorderError.set(
				error instanceof DOMException && error.name === 'NotAllowedError'
					? 'Microphone access was denied. Allow it in browser settings or use the text note fallback.'
					: error instanceof Error
						? error.message
						: 'The microphone could not be started.',
			);
			this.textFallback.set(true);
		}
	}

	protected async stopRecording(): Promise<void> {
		const mode = this.recordingMode();
		if (!mode) return;
		this.recorderError.set('');
		try {
			const blob = await this.recorder.stop();
			if (mode.kind === 'capture')
				await this.voiceStore.enqueueAudio(
					blob,
					this.selectedDriveId() || null,
				);
			else await this.voiceStore.correctAudio(mode.id, blob);
			this.focusHistory();
		} catch (error) {
			this.recorderError.set(
				error instanceof Error
					? error.message
					: 'The recording could not be completed.',
			);
		} finally {
			this.recordingMode.set(null);
		}
	}

	protected cancelRecording(): void {
		this.recorder.cancel();
		this.recordingMode.set(null);
		this.recorderError.set('Recording cancelled. Nothing was saved.');
	}

	protected async submitTextNote(): Promise<void> {
		const note = this.textNote().trim();
		if (!note) {
			this.recorderError.set('Describe the track note before saving it.');
			return;
		}
		this.recorderError.set('');
		await this.voiceStore.enqueueText(note, this.selectedDriveId() || null);
		this.textNote.set('');
		this.textFallback.set(false);
		this.focusHistory();
	}

	protected beginCorrection(id: string): void {
		this.correctingId.set(id);
		this.correctionText.set('');
	}

	protected cancelCorrection(): void {
		this.correctingId.set(null);
		this.correctionText.set('');
	}

	protected async applyTextCorrection(id: string): Promise<void> {
		const correction = this.correctionText().trim();
		if (!correction) {
			this.recorderError.set('Say or type the correction first.');
			return;
		}
		const updated = await this.voiceStore.correctText(id, correction);
		if (updated) this.cancelCorrection();
	}

	protected hasUncertainty(update: VoiceUpdate): boolean {
		const draft = update.draft;
		return Boolean(
			draft &&
				(draft.unresolvedNotes.length ||
					draft.setupChanges.some((item) => item.needsReview) ||
					draft.problems.some((item) => item.needsReview) ||
					draft.conditions.some((item) => item.needsReview) ||
					draft.driveSessionNotes.some((item) => item.needsReview) ||
					draft.consumables.some((item) => item.needsReview)),
		);
	}

	protected contextCar(update: VoiceUpdate): string {
		return this.contextCars()[update.id] ?? update.carId;
	}

	protected changeContextCar(update: VoiceUpdate, event: Event): void {
		const carId = (event.currentTarget as HTMLSelectElement).value;
		this.contextCars.update((values) => ({ ...values, [update.id]: carId }));
	}

	protected async saveContext(update: VoiceUpdate): Promise<void> {
		const carId = this.contextCar(update);
		const result = await this.voiceStore.updateContext(
			update.id,
			carId,
			carId === this.carId() ? this.selectedDriveId() || null : null,
		);
		if (result && carId !== this.carId())
			await this.router.navigate(['/garage', carId, 'voice']);
	}

	protected process(id: string): void {
		void this.voiceStore.process(id);
	}

	protected confirm(update: VoiceUpdate, acceptUnresolved: boolean): void {
		void this.voiceStore.confirm(update.id, acceptUnresolved);
	}

	protected retryQueued(): void {
		void this.voiceStore.retryQueued();
	}

	protected confidenceLabel(confidence: string, needsReview: boolean): string {
		return needsReview
			? `${confidence} confidence · review`
			: `${confidence} confidence`;
	}

	private focusHistory(): void {
		queueMicrotask(() =>
			this.document.getElementById('voice-history-title')?.focus(),
		);
	}
}
