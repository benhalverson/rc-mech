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
import { DRIVE_SESSION_CONTEXT } from '../car/drive-sessions/drive-session-context';
import { VoiceLogStore } from './voice-log-store';
import type {
	VoiceConfidence,
	VoiceRecordingMode,
	VoiceUpdate,
} from './voice.models';
import {
	voiceConfidenceLabel,
	voiceRecordingDuration,
	voiceUpdateHasUncertainty,
} from './voice.rules';

@Component({
	selector: 'app-voice-note-workspace',
	imports: [DatePipe, RouterLink],
	templateUrl: './voice-note-workspace.html',
	styleUrl: './voice-note-workspace.css',
	host: {
		class: 'block',
		'(window:online)': 'retryQueued()',
	},
})
export class VoiceNoteWorkspace {
	readonly carId = input.required<string>();
	readonly archived = input(false);
	readonly showHistory = input(false);
	protected readonly driveSessionContext = inject(DRIVE_SESSION_CONTEXT);
	protected readonly voiceStore = inject(VoiceLogStore);
	private readonly router = inject(Router);
	private readonly document = inject(DOCUMENT);
	protected readonly textFallback = signal(false);
	protected readonly textNote = signal('');
	protected readonly textNoteError = signal('');
	protected readonly correctionText = signal('');
	protected readonly correctionError = signal('');
	protected readonly correctingId = signal<string | null>(null);
	protected readonly contextCars = signal<Record<string, string>>({});
	protected readonly selectedDriveSessionId = linkedSignal(
		() =>
			this.driveSessionContext.sessions().find((session) => !session.deletedAt)
				?.id ?? '',
	);
	protected readonly visibleUpdates = computed(() =>
		this.showHistory()
			? this.voiceStore.updates()
			: this.voiceStore
					.updates()
					.filter(
						(update) =>
							update.status !== 'saved' && update.status !== 'discarded',
					),
	);
	protected readonly hasReview = computed(
		() =>
			this.voiceStore.localCaptures().length > 0 ||
			this.visibleUpdates().length > 0,
	);
	protected readonly recordingDuration = computed(() =>
		voiceRecordingDuration(this.voiceStore.elapsedSeconds()),
	);

	constructor() {
		let handledOperationId = 0;
		effect(() => {
			const carId = this.carId();
			if (!carId) return;
			this.driveSessionContext.selectCar(carId);
			this.voiceStore.selectCar(carId);
		});
		effect(() => {
			const outcome = this.voiceStore.outcome();
			if (
				outcome.status === 'idle' ||
				outcome.status === 'pending' ||
				outcome.operationId === handledOperationId
			)
				return;
			handledOperationId = outcome.operationId;
			if (outcome.status === 'failed') {
				if (outcome.operation === 'start-recording') {
					this.textFallback.set(true);
					this.focusTextNote();
				}
				return;
			}
			if (
				outcome.operation === 'capture-audio' ||
				outcome.operation === 'capture-text'
			) {
				this.textNote.set('');
				this.textNoteError.set('');
				this.textFallback.set(false);
				this.focusReview();
			}
			if (
				outcome.operation === 'correct-text' ||
				outcome.operation === 'correct-audio'
			) {
				this.cancelCorrection();
				this.focusReview();
			}
			if (
				outcome.operation === 'update-context' &&
				outcome.destinationCarId &&
				outcome.destinationCarId !== this.carId()
			)
				void this.router.navigate([
					'/garage',
					outcome.destinationCarId,
					'overview',
				]);
		});
		this.voiceStore.detectRecorderSupport();
	}

	protected setDriveSession(event: Event): void {
		this.selectedDriveSessionId.set(
			(event.currentTarget as HTMLSelectElement).value,
		);
	}

	protected showTextFallback(): void {
		this.textFallback.set(true);
		this.focusTextNote();
	}

	protected hideTextFallback(): void {
		this.textFallback.set(false);
		this.textNote.set('');
		this.textNoteError.set('');
	}

	protected updateTextNote(event: Event): void {
		this.textNote.set((event.currentTarget as HTMLTextAreaElement).value);
		this.textNoteError.set('');
	}

	protected updateCorrection(event: Event): void {
		this.correctionText.set((event.currentTarget as HTMLInputElement).value);
		this.correctionError.set('');
	}

	protected startRecording(mode: VoiceRecordingMode): void {
		this.voiceStore.startRecording(mode);
	}

	protected stopRecording(): void {
		this.voiceStore.stopRecording({
			driveSessionId: this.selectedDriveSessionId() || null,
		});
	}

	protected cancelRecording(): void {
		this.voiceStore.cancelRecording();
	}

	protected submitTextNote(): void {
		const text = this.textNote().trim();
		if (!text) {
			this.textNoteError.set('Describe the track note before saving it.');
			this.focusTextNote();
			return;
		}
		this.textNoteError.set('');
		this.voiceStore.captureText({
			text,
			driveSessionId: this.selectedDriveSessionId() || null,
		});
	}

	protected beginCorrection(id: string): void {
		this.correctingId.set(id);
		this.correctionText.set('');
		this.correctionError.set('');
	}

	protected cancelCorrection(): void {
		this.correctingId.set(null);
		this.correctionText.set('');
		this.correctionError.set('');
	}

	protected applyTextCorrection(id: string): void {
		const text = this.correctionText().trim();
		if (!text) {
			this.correctionError.set('Say or type the correction first.');
			this.focusCorrection(id);
			return;
		}
		this.correctionError.set('');
		this.voiceStore.correctText({ id, text });
	}

	protected contextCar(update: VoiceUpdate): string {
		return this.contextCars()[update.id] ?? update.carId;
	}

	protected changeContextCar(update: VoiceUpdate, event: Event): void {
		const carId = (event.currentTarget as HTMLSelectElement).value;
		this.contextCars.update((values) => ({ ...values, [update.id]: carId }));
	}

	protected saveContext(update: VoiceUpdate): void {
		const carId = this.contextCar(update);
		this.voiceStore.updateContext({
			id: update.id,
			carId,
			driveSessionId:
				carId === this.carId() ? this.selectedDriveSessionId() || null : null,
		});
	}

	protected retryQueued(): void {
		this.voiceStore.retryQueued();
	}

	protected hasUncertainty(update: VoiceUpdate): boolean {
		return voiceUpdateHasUncertainty(update);
	}

	protected confidenceLabel(
		confidence: VoiceConfidence,
		needsReview: boolean,
	): string {
		return voiceConfidenceLabel(confidence, needsReview);
	}

	private focusReview(): void {
		queueMicrotask(() =>
			this.document.getElementById('voice-review-title')?.focus(),
		);
	}

	private focusTextNote(): void {
		queueMicrotask(() =>
			this.document.getElementById('voice-text-note')?.focus(),
		);
	}

	private focusCorrection(id: string): void {
		queueMicrotask(() =>
			this.document.getElementById(`correction-${id}`)?.focus(),
		);
	}
}
