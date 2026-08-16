import {
	afterRenderEffect,
	Component,
	computed,
	ElementRef,
	effect,
	inject,
	input,
	signal,
} from '@angular/core';
import {
	LucideCheckCircle2,
	LucidePause,
	LucidePlay,
	LucideRefreshCw,
	LucideTriangleAlert,
	LucideUpload,
	LucideX,
} from '@lucide/angular';
import type { DriveSession } from '../drive-session.models';
import { DrivingAnalysisStore } from './driving-analysis-store';
import {
	MAX_RACE_RECORDING_BYTES,
	SUPPORTED_RACE_RECORDING_TYPES,
} from './race-recording.models';

type DisplayStatus =
	| 'idle'
	| 'uploading'
	| 'paused'
	| 'cancelling'
	| 'removing'
	| 'removal-failed'
	| 'complete'
	| 'failed';

@Component({
	selector: 'app-race-recording-upload',
	imports: [
		LucideCheckCircle2,
		LucidePause,
		LucidePlay,
		LucideRefreshCw,
		LucideTriangleAlert,
		LucideUpload,
		LucideX,
	],
	templateUrl: './race-recording-upload.html',
	host: { class: 'block border-t border-alloy-separator pb-4 pt-3' },
})
export class RaceRecordingUpload {
	readonly carId = input.required<string>();
	readonly driveSession = input.required<DriveSession>();
	readonly carArchived = input(false);
	protected readonly store = inject(DrivingAnalysisStore);
	private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
	private focusAfterRender: 'file' | 'pause' | null = null;
	protected readonly fileError = signal('');
	protected readonly recording = computed(() =>
		this.store
			.recordings()
			.find((recording) => recording.driveSessionId === this.driveSession().id),
	);
	protected readonly transfer = computed(() => {
		const transfer = this.store.transfer();
		return transfer.driveSessionId === this.driveSession().id ? transfer : null;
	});
	protected readonly removal = computed(() => {
		const removal = this.store.removal();
		const recordingId =
			this.transfer()?.recordingId ?? this.recording()?.id ?? null;
		return removal.driveSessionId === this.driveSession().id &&
			removal.recordingId === recordingId
			? removal
			: null;
	});
	protected readonly status = computed<DisplayStatus>(() => {
		const removal = this.removal();
		if (removal?.status === 'removing') return 'removing';
		if (removal?.status === 'failed') return 'removal-failed';
		const transfer = this.transfer();
		if (transfer) return transfer.status;
		const recording = this.recording();
		if (recording?.status === 'validating') return 'complete';
		return recording?.status === 'uploading' ? 'paused' : 'idle';
	});
	protected readonly completedRecording = computed(
		() =>
			this.recording()?.status === 'validating' ||
			this.transfer()?.status === 'complete',
	);
	protected readonly displayFileName = computed(
		() =>
			this.recording()?.fileName ??
			this.store.selectedFileName(this.driveSession().id),
	);
	protected readonly uploadedBytes = computed(
		() =>
			this.transfer()?.uploadedBytes ?? this.recording()?.uploadedBytes ?? 0,
	);
	protected readonly totalBytes = computed(
		() => this.transfer()?.totalBytes ?? this.recording()?.sizeBytes ?? 0,
	);
	protected readonly declaredSize = computed(() => {
		const byteSize = this.totalBytes();
		return byteSize > 0 ? `${byteSize.toLocaleString()} bytes` : '';
	});
	protected readonly progressPercent = computed(() => {
		const total = this.totalBytes();
		return total > 0
			? Math.min(100, Math.round((this.uploadedBytes() / total) * 100))
			: 0;
	});
	protected readonly progressLabel = computed(() => {
		switch (this.status()) {
			case 'cancelling':
				return 'Removing recording…';
			case 'paused':
				return 'Upload paused';
			case 'failed':
				return 'Upload needs attention';
			default:
				return 'Uploading privately…';
		}
	});
	protected readonly canSelectFile = computed(
		() =>
			!this.carArchived() &&
			!this.driveSession().deletedAt &&
			this.status() !== 'complete' &&
			!this.store.pending(),
	);
	constructor() {
		effect(() => this.store.selectCar(this.carId()));
		afterRenderEffect(() => {
			const status = this.status();
			if (this.focusAfterRender === 'pause' && status === 'uploading') {
				this.focusAfterRender = null;
				this.host.nativeElement
					.querySelector<HTMLButtonElement>('[data-race-recording-pause]')
					?.focus();
			}
			if (
				this.focusAfterRender === 'file' &&
				status === 'idle' &&
				this.canSelectFile()
			) {
				this.focusAfterRender = null;
				this.host.nativeElement
					.querySelector<HTMLInputElement>('[data-race-recording-file]')
					?.focus();
			}
		});
	}

	protected selectFile(event: Event): void {
		this.fileError.set('');
		const control = event.target as HTMLInputElement;
		const file = control.files?.item(0);
		control.value = '';
		if (!file) return;
		if (!this.canSelectFile()) {
			this.fileError.set(
				'Finish the current upload before choosing another Race recording.',
			);
			return;
		}
		if (
			!(SUPPORTED_RACE_RECORDING_TYPES as readonly string[]).includes(file.type)
		) {
			this.fileError.set('Choose an MP4, MOV, or WebM Race recording.');
			return;
		}
		if (file.size < 1 || file.size > MAX_RACE_RECORDING_BYTES) {
			this.fileError.set('Choose a Race recording no larger than 10 GiB.');
			return;
		}
		this.focusAfterRender = 'pause';
		this.store.startUpload({
			carId: this.carId(),
			driveSessionId: this.driveSession().id,
			file,
		});
	}

	protected pause(): void {
		this.store.pauseUpload(this.driveSession().id);
	}

	protected resume(): void {
		this.fileError.set('');
		this.store.resumeUpload(this.driveSession().id);
	}

	protected remove(): void {
		const recordingId =
			this.transfer()?.recordingId ?? this.recording()?.id ?? null;
		if (!recordingId) return;
		this.fileError.set('');
		this.focusAfterRender = 'file';
		this.store.removeRecording({
			carId: this.carId(),
			driveSessionId: this.driveSession().id,
			recordingId,
		});
	}
}
