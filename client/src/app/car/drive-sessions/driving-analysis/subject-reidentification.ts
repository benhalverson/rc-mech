import {
	Component,
	computed,
	ElementRef,
	inject,
	input,
	linkedSignal,
	type OnChanges,
	signal,
	viewChild,
} from '@angular/core';
import {
	type DrivingAnalysis,
	type SubjectBox,
	subjectSeed,
} from './driving-analysis.models';
import type { RaceRecording } from './race-recording.models';
import { ReidentificationStore } from './reidentification-store';
import { SubjectBoxEditor } from './subject-box-editor';

@Component({
	selector: 'app-subject-reidentification',
	imports: [SubjectBoxEditor],
	templateUrl: './subject-reidentification.html',
	host: { class: 'block' },
})
export class SubjectReidentification implements OnChanges {
	readonly headingLevel = input<3 | 5>(5);
	readonly analysis = input.required<DrivingAnalysis>();
	readonly recording = input.required<RaceRecording>();
	protected readonly store = inject(ReidentificationStore);
	protected readonly selectedFrame = linkedSignal({
		source: () => this.store.context(),
		computation: () => 0,
	});
	/** Binds gateway presentation metadata to the current immutable recording identity. */
	protected readonly frames = computed(() => {
		const recording = this.recording();
		return this.store.framesFor(
			recording.media
				? {
						recordingId: recording.id,
						checksumSha256: recording.media.checksumSha256,
					}
				: null,
		);
	});
	/** Keeps the selected frame metadata local to the correction editor. */
	protected readonly draft = computed(
		() =>
			this.frames()[this.selectedFrame()] ?? {
				timestampMs: 0,
				frameIndex: 0,
			},
	);
	/** Renders the selected gateway URL while readiness remains local. */
	protected readonly previewUrl = computed(
		() => this.frames()[this.selectedFrame()]?.contentUrl ?? null,
	);
	protected readonly loadedFrameUrl = signal('');
	protected readonly failedFrameUrl = signal('');
	protected readonly frameReady = computed(() => {
		const url = this.previewUrl();
		return (
			url !== null &&
			this.loadedFrameUrl() === url &&
			this.failedFrameUrl() !== url
		);
	});
	protected readonly box = signal<SubjectBox>({
		x: 0.4,
		y: 0.4,
		width: 0.1,
		height: 0.1,
	});
	protected readonly boxValid = signal(true);
	protected readonly error = signal('');
	private readonly timestampField =
		viewChild.required<ElementRef<HTMLInputElement>>('timestampField');
	private selectedId = '';

	ngOnChanges(): void {
		const analysis = this.analysis();
		this.store.select(analysis.id, analysis.stateVersion);
		if (this.selectedId === analysis.id) return;
		this.selectedId = analysis.id;
		this.box.set(analysis.subjectSeed.box);
		this.error.set('');
	}

	/** Accepts readiness only for the currently displayed exact source image. */
	protected imageLoaded(url: string): void {
		if (url !== this.previewUrl()) return;
		this.loadedFrameUrl.set(url);
		this.failedFrameUrl.set('');
	}

	/** Keeps a late image failure from changing the current frame's retry state. */
	protected imageFailed(url: string): void {
		if (url !== this.previewUrl()) return;
		this.failedFrameUrl.set(url);
	}

	protected selectFrame(event: Event): void {
		const frameIndex = (event.target as HTMLInputElement).valueAsNumber;
		const frame = this.store.context()?.frames[frameIndex];
		if (!frame) return;
		this.selectedFrame.set(frameIndex);
	}

	protected retrySaved(): void {
		const context = this.store.context();
		if (context?.pendingCorrection)
			this.store.correct({
				analysisId: this.analysis().id,
				context,
				subjectSeed: context.pendingCorrection.subjectSeed,
			});
	}

	/** Validates local readiness and submits only canonical seed fields. */
	protected submit(event: Event): void {
		event.preventDefault();
		const media = this.recording().media;
		if (!media || !this.frameReady()) {
			this.error.set(
				'Wait for the exact source frame image to load before confirming the Subject.',
			);
			this.timestampField().nativeElement.focus();
			return;
		}
		const context = this.store.context();
		const analysis = this.analysis();
		const candidate = {
			timestampMs: this.draft().timestampMs,
			frameIndex: this.draft().frameIndex,
			identity: analysis.subjectSeed.identity,
			box: this.box(),
		};
		const parsed = subjectSeed.safeParse(candidate);
		if (
			!context ||
			!parsed.success ||
			!this.boxValid() ||
			!context.frames.some(
				(frame) =>
					frame.frameIndex === candidate.frameIndex &&
					frame.timestampMs === candidate.timestampMs,
			) ||
			candidate.timestampMs <= context.gap.startTimestampMs ||
			candidate.timestampMs >= analysis.raceWindow.endTimestampMs ||
			candidate.frameIndex >= media.decodedFrameCount
		) {
			this.error.set(
				'Choose a later clear frame inside the Race window and enter a complete normalized Subject box.',
			);
			this.timestampField().nativeElement.focus();
			return;
		}
		this.error.set('');
		this.store.correct({
			analysisId: analysis.id,
			context,
			subjectSeed: parsed.data,
		});
	}
}
