import {
	Component,
	computed,
	input,
	linkedSignal,
	output,
	signal,
} from '@angular/core';
import { disabled, FormField, form } from '@angular/forms/signals';
import type {
	Point,
	SaveTrackMapDraftCommand,
	SelectTrackMapFrameCommand,
	TrackCorner,
	TrackMapRecording,
	TrackMapVersion,
} from './track-map.models';
import { TrackMapApproval } from './track-map-approval';
import { TrackMapGeometry } from './track-map-geometry';
import { validateTrackCorners } from './track-map-rules';

type PointTarget = 'entryStart' | 'entryEnd' | 'exitStart' | 'exitEnd';
type GeometryTarget = PointTarget | 'viewPosition' | 'viewSize';

const pointLocation = {
	entryStart: { gate: 'entryGate', edge: 'start' },
	entryEnd: { gate: 'entryGate', edge: 'end' },
	exitStart: { gate: 'exitGate', edge: 'start' },
	exitEnd: { gate: 'exitGate', edge: 'end' },
} as const;

const isPointTarget = (target: GeometryTarget): target is PointTarget =>
	target in pointLocation;

@Component({
	selector: 'app-track-map-editor',
	host: { class: 'block' },
	imports: [FormField, TrackMapApproval, TrackMapGeometry],
	templateUrl: './track-map-editor.html',
})
export class TrackMapEditor {
	readonly version = input<TrackMapVersion | null>(null);
	readonly busy = input(false);
	readonly recordings = input<readonly TrackMapRecording[]>([]);
	readonly saveRequested = output<SaveTrackMapDraftCommand>();
	readonly frameRequested = output<SelectTrackMapFrameCommand>();
	readonly approveRequested = output<void>();
	protected readonly selectedRecordingId = signal('');
	protected readonly timestampMs = signal(0);
	protected readonly corners = linkedSignal<
		{ id: string; stateVersion: number } | null,
		TrackCorner[]
	>({
		source: () => {
			const version = this.version();
			return version
				? { id: version.id, stateVersion: version.stateVersion }
				: null;
		},
		computation: (revision, previous) =>
			revision?.id &&
			previous?.source?.id === revision.id &&
			previous.source.stateVersion === revision.stateVersion
				? previous.value
				: [...(this.version()?.corners ?? [])],
	});
	protected readonly cornerFields = form(this.corners, (path) => {
		disabled(path, {
			when: () => (this.busy() ? 'A Track-map save is in progress.' : false),
		});
	});
	protected readonly selectedCorner = linkedSignal<
		{ id: string; stateVersion: number } | null,
		number | null
	>({
		source: () => {
			const version = this.version();
			return version
				? { id: version.id, stateVersion: version.stateVersion }
				: null;
		},
		computation: (revision, previous) =>
			previous &&
			previous.source?.id === revision?.id &&
			previous?.source?.stateVersion === revision?.stateVersion
				? previous.value
				: this.version()?.corners.length
					? 0
					: null,
	});
	protected readonly selectedTarget = signal<GeometryTarget>('entryStart');
	protected readonly selectedPointTarget = computed(() => {
		const target = this.selectedTarget();
		return isPointTarget(target) ? target : null;
	});
	protected readonly selectedRecording = computed(() =>
		this.recordings().find(
			(recording) => recording.id === this.selectedRecordingId(),
		),
	);
	protected readonly frameUrl = computed(() => {
		const version = this.version();
		return version?.referenceFrame
			? `/api/v1/track-map-versions/${encodeURIComponent(version.id)}/reference-frame/content`
			: '';
	});
	protected readonly targetLabel = computed(() => {
		const target = this.selectedTarget();
		if (target.startsWith('entry')) return 'Entry gate';
		if (target.startsWith('exit')) return 'Exit gate';
		return 'Corner view';
	});
	protected readonly errors = computed(() =>
		validateTrackCorners(this.corners()),
	);
	protected readonly activeCorner = computed(
		() => this.corners().at(this.selectedCorner() ?? -1) ?? null,
	);
	protected readonly pointLocation = pointLocation;

	protected addCorner(): void {
		const corners = this.corners();
		const order = Math.max(0, ...corners.map((corner) => corner.order)) + 1;
		const keys = new Set(corners.map((corner) => corner.key));
		let keyIndex = 1;
		while (keys.has(`turn-${keyIndex}`)) keyIndex += 1;
		const next: TrackCorner = {
			key: `turn-${keyIndex}`,
			name: `Turn ${order}`,
			order,
			entryGate: {
				start: { x: 0.2, y: 0.7 },
				end: { x: 0.3, y: 0.7 },
				direction: 'forward',
			},
			exitGate: {
				start: { x: 0.5, y: 0.5 },
				end: { x: 0.6, y: 0.5 },
				direction: 'forward',
			},
			cornerView: { x: 0.15, y: 0.35, width: 0.35, height: 0.3 },
		};
		this.corners.set([...corners, next]);
		this.selectedCorner.set(corners.length);
	}

	protected removeCorner(selected: number): void {
		const next = this.corners()
			.filter((_, index) => index !== selected)
			.map((corner, index) => ({ ...corner, order: index + 1 }));
		this.corners.set(next);
		this.selectedCorner.set(
			next.length ? Math.min(selected, next.length - 1) : null,
		);
	}

	protected selectCorner(index: number): void {
		this.selectedCorner.set(index);
	}
	protected selectTarget(target: GeometryTarget): void {
		this.selectedTarget.set(target);
	}
	protected selectRecording(recordingId: string): void {
		this.selectedRecordingId.set(recordingId);
		this.timestampMs.set(0);
	}
	protected setTimestamp(value: string): void {
		const timestampMs = Number(value);
		if (Number.isSafeInteger(timestampMs) && timestampMs >= 0)
			this.timestampMs.set(timestampMs);
	}
	protected selectFrame(): void {
		const recording = this.selectedRecording();
		const timestampMs = this.timestampMs();
		if (recording && timestampMs < recording.durationMs)
			this.frameRequested.emit({ raceVideoId: recording.id, timestampMs });
	}

	protected moveSelected(event: KeyboardEvent, selected: number): void {
		const delta = event.shiftKey ? 0.01 : 0.0025;
		const movement: Record<string, Point> = {
			ArrowLeft: { x: -delta, y: 0 },
			ArrowRight: { x: delta, y: 0 },
			ArrowUp: { x: 0, y: -delta },
			ArrowDown: { x: 0, y: delta },
		};
		const change = movement[event.key];
		if (!change) return;
		event.preventDefault();
		const corner = this.corners()[selected] as TrackCorner;
		const target = this.selectedTarget();
		if (isPointTarget(target)) {
			const point = this.point(corner, target);
			this.updatePoint(selected, target, {
				x: point.x + change.x,
				y: point.y + change.y,
			});
			return;
		}
		const view = corner.cornerView;
		this.updateView(
			selected,
			target === 'viewPosition'
				? { ...view, x: view.x + change.x, y: view.y + change.y }
				: {
						...view,
						width: view.width + change.x,
						height: view.height + change.y,
					},
		);
	}

	protected moveFromCanvas(event: MouseEvent, selected: number): void {
		const element = event.currentTarget as HTMLElement;
		const bounds = element.getBoundingClientRect();
		const point = {
			x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
			y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
		};
		const target = this.selectedTarget();
		if (isPointTarget(target)) {
			this.updatePoint(selected, target, point);
			return;
		}
		const view = (this.corners()[selected] as TrackCorner).cornerView;
		this.updateView(
			selected,
			target === 'viewPosition'
				? { ...view, ...point }
				: { ...view, width: point.x - view.x, height: point.y - view.y },
		);
	}

	protected saveDraft(): void {
		this.saveRequested.emit({ corners: this.corners() });
	}
	protected point(corner: TrackCorner, target: PointTarget): Point {
		const location = pointLocation[target];
		return corner[location.gate][location.edge];
	}
	private updatePoint(
		selected: number,
		target: PointTarget,
		point: Point,
	): void {
		this.updateActive(selected, (corner) => {
			const location = pointLocation[target];
			return {
				...corner,
				[location.gate]: {
					...corner[location.gate],
					[location.edge]: point,
				},
			};
		});
	}
	private updateView(
		selected: number,
		cornerView: TrackCorner['cornerView'],
	): void {
		this.updateActive(selected, (corner) => ({ ...corner, cornerView }));
	}
	private updateActive(
		selected: number,
		update: (corner: TrackCorner) => TrackCorner,
	): void {
		this.corners.update((corners) =>
			corners.map((corner, index) =>
				index === selected ? update(corner) : corner,
			),
		);
	}
}
