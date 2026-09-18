import {
	Component,
	ElementRef,
	inject,
	input,
	type OnChanges,
	signal,
	viewChild,
} from '@angular/core';
import { CorrectionPlayer } from './correction-player';
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
	readonly analysis = input.required<DrivingAnalysis>();
	readonly recording = input.required<RaceRecording>();
	protected readonly store = inject(ReidentificationStore);
	protected readonly draft = signal({ timestampMs: 0, frameIndex: 0 });
	protected readonly selectedFrame = signal(0);
	private readonly player = inject(CorrectionPlayer);
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
		this.draft.set({
			timestampMs: analysis.subjectSeed.timestampMs,
			frameIndex: analysis.subjectSeed.frameIndex,
		});
		this.error.set('');
	}

	protected seek(event: Event, player: HTMLVideoElement): void {
		const frameIndex = (event.target as HTMLInputElement).valueAsNumber;
		const frame = this.store.context()?.frames[frameIndex];
		if (!frame) return;
		this.selectedFrame.set(frameIndex);
		this.player.showFrame(player, frame.timestampMs);
		this.draft.set(frame);
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

	protected submit(event: Event): void {
		event.preventDefault();
		const context = this.store.context();
		const analysis = this.analysis();
		const candidate = {
			...this.draft(),
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
			candidate.frameIndex >= (this.recording().media?.decodedFrameCount ?? 0)
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
