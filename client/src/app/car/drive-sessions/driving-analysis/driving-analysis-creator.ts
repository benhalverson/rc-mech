import {
	Component,
	computed,
	effect,
	inject,
	input,
	signal,
} from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { TrackMapGeometry } from '../../../track-maps/track-map-geometry';
import {
	MAX_RACE_WINDOW_DURATION_MS,
	type SubjectBox,
} from './driving-analysis.models';
import { DrivingAnalysisStore } from './driving-analysis-store';
import type { RaceRecording } from './race-recording.models';
import { SubjectBoxEditor } from './subject-box-editor';

type CreationForm = {
	approvedTrackMapVersionId: string;
	startTimestampMs: number;
	endTimestampMs: number;
	seedTimestampMs: number;
};

const DEFAULT_BOX: SubjectBox = {
	x: 0.45,
	y: 0.45,
	width: 0.1,
	height: 0.08,
};

const finiteInteger = (value: number): boolean =>
	Number.isFinite(value) && Number.isInteger(value);
const titleCase = (value: string): string =>
	`${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;

@Component({
	selector: 'app-driving-analysis-creator',
	imports: [FormField, SubjectBoxEditor, TrackMapGeometry],
	templateUrl: './driving-analysis-creator.html',
	host: { class: 'block' },
})
export class DrivingAnalysisCreator {
	readonly carId = input.required<string>();
	readonly driveSessionId = input.required<string>();
	readonly recording = input.required<RaceRecording>();
	protected readonly store = inject(DrivingAnalysisStore);
	private readonly initializedRecording = signal('');
	protected readonly currentTimestampMs = signal(0);
	protected readonly playing = signal(false);
	protected readonly box = signal<SubjectBox>(DEFAULT_BOX);
	protected readonly boxValid = signal(true);
	protected readonly form = signal<CreationForm>({
		approvedTrackMapVersionId: '',
		startTimestampMs: 0,
		endTimestampMs: 1,
		seedTimestampMs: 0,
	});
	protected readonly fields = form(this.form);
	protected readonly formError = signal('');
	protected readonly durationMs = computed(
		() => this.recording().media?.durationMs ?? 0,
	);
	protected readonly creation = computed(() => {
		const creation = this.store.analysisCreation();
		return creation.driveSessionId === this.driveSessionId() ? creation : null;
	});
	protected readonly analysis = computed(
		() => this.creation()?.analysis ?? null,
	);
	protected readonly canRetryAnalysis = computed(() => {
		const status = this.analysis()?.status;
		return (
			status === 'running' ||
			status === 'awaiting-reidentification' ||
			status === 'failed'
		);
	});
	protected readonly selectedMap = computed(() =>
		this.store
			.approvedTrackMaps()
			.find((map) => map.id === this.form().approvedTrackMapVersionId),
	);
	protected readonly errors = computed(() => {
		const form = this.form();
		const errors: string[] = [];
		if (!form.approvedTrackMapVersionId)
			errors.push('Choose an approved Track-map version.');
		if (
			!finiteInteger(form.startTimestampMs) ||
			!finiteInteger(form.endTimestampMs) ||
			form.startTimestampMs < 0 ||
			form.endTimestampMs <= form.startTimestampMs
		)
			errors.push('Race window must end after it starts.');
		else if (
			form.endTimestampMs - form.startTimestampMs >
			MAX_RACE_WINDOW_DURATION_MS
		)
			errors.push('Race window must be 15 minutes or shorter.');
		if (form.endTimestampMs > this.durationMs())
			errors.push('Race window must stay inside the recording.');
		if (
			!finiteInteger(form.seedTimestampMs) ||
			form.seedTimestampMs < form.startTimestampMs ||
			form.seedTimestampMs >= form.endTimestampMs
		)
			errors.push('Subject timestamp must be inside the Race window.');
		if (!this.boxValid())
			errors.push('Enter a complete normalized Subject box.');
		return errors;
	});

	constructor() {
		effect(() => {
			const recording = this.recording();
			const firstMap = this.store.approvedTrackMaps()[0];
			if (this.initializedRecording() === recording.id) {
				if (!this.form().approvedTrackMapVersionId && firstMap)
					this.form.update((current) => ({
						...current,
						approvedTrackMapVersionId: firstMap.id,
					}));
				this.store.selectTrackMap(
					this.form().approvedTrackMapVersionId || null,
				);
				return;
			}
			this.initializedRecording.set(recording.id);
			const duration = recording.media?.durationMs ?? 1;
			this.form.set({
				approvedTrackMapVersionId: firstMap?.id ?? '',
				startTimestampMs: 0,
				endTimestampMs: Math.min(duration, MAX_RACE_WINDOW_DURATION_MS),
				seedTimestampMs: 0,
			});
			this.box.set(DEFAULT_BOX);
			this.boxValid.set(true);
			this.currentTimestampMs.set(0);
			this.playing.set(false);
			this.formError.set('');
			this.store.selectTrackMap(firstMap?.id ?? null);
		});
	}

	protected updateCurrentTime(currentTimeSeconds: number): void {
		this.currentTimestampMs.set(
			Math.min(
				this.durationMs(),
				Math.max(0, Math.round(currentTimeSeconds * 1000)),
			),
		);
	}

	protected seek(event: Event, player: HTMLVideoElement): void {
		const timestamp = Math.round(
			(event.target as HTMLInputElement).valueAsNumber,
		);
		player.currentTime = timestamp / 1000;
		this.currentTimestampMs.set(timestamp);
	}

	protected togglePlayback(player: HTMLVideoElement): void {
		if (player.paused) void player.play().catch(() => this.playing.set(false));
		else player.pause();
	}

	protected mark(
		field: 'startTimestampMs' | 'endTimestampMs' | 'seedTimestampMs',
	): void {
		this.form.update((current) => ({
			...current,
			[field]: this.currentTimestampMs(),
		}));
		this.formError.set('');
	}

	protected stageLabel(stage: string): string {
		return titleCase(stage.replace('-', ' '));
	}

	protected submit(event: Event): void {
		event.preventDefault();
		this.fields().markAsTouched();
		const errors = this.errors();
		if (errors.length) {
			this.formError.set(errors[0] as string);
			return;
		}
		const form = this.form();
		const immutableInput = {
			carId: this.carId(),
			driveSessionId: this.driveSessionId(),
			raceVideoId: this.recording().id,
			approvedTrackMapVersionId: form.approvedTrackMapVersionId,
			raceWindow: {
				startTimestampMs: form.startTimestampMs,
				endTimestampMs: form.endTimestampMs,
			},
			subjectSeed: {
				timestampMs: form.seedTimestampMs,
				box: this.box(),
			},
		};
		this.formError.set('');
		this.store.createAnalysis(immutableInput);
	}
}
