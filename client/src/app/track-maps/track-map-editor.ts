import {
	Component,
	computed,
	effect,
	input,
	linkedSignal,
	output,
	signal,
	untracked,
} from '@angular/core';
import type { Point, TrackCorner, TrackMapVersion } from './track-map.models';
import { validateTrackCorners } from './track-map-rules';

type PointTarget = 'entryStart' | 'entryEnd' | 'exitStart' | 'exitEnd';

@Component({
	selector: 'app-track-map-editor',
	host: { class: 'block' },
	templateUrl: './track-map-editor.html',
})
export class TrackMapEditor {
	readonly version = input<TrackMapVersion | null>(null);
	readonly busy = input(false);
	readonly saveRequested = output<readonly TrackCorner[]>();
	protected readonly corners = signal<TrackCorner[]>([]);
	protected readonly selectedCorner = signal<number | null>(null);
	private readonly loadedVersionId = signal<string | null>(null);
	protected readonly selectedPoint = linkedSignal<PointTarget>(
		() => 'entryStart',
	);
	protected readonly errors = computed(() =>
		validateTrackCorners(this.corners()),
	);
	protected readonly activeCorner = computed(
		() => this.corners().at(this.selectedCorner() ?? -1) ?? null,
	);
	protected readonly pointTargets: readonly PointTarget[] = [
		'entryStart',
		'entryEnd',
		'exitStart',
		'exitEnd',
	];

	constructor() {
		effect(() => {
			const version = this.version();
			untracked(() => {
				const versionId = version?.id ?? null;
				if (versionId === this.loadedVersionId()) return;
				const corners = version?.corners ?? [];
				this.loadedVersionId.set(versionId);
				this.corners.set(corners);
				this.selectedCorner.set(corners.length ? 0 : null);
			});
		});
	}

	protected addCorner(): void {
		const order = this.corners().length + 1;
		const key = `turn-${order}`;
		const next: TrackCorner = {
			key,
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
		this.corners.set([...this.corners(), next]);
		this.selectedCorner.set(order - 1);
	}

	protected removeCorner(): void {
		const selected = this.selectedCorner();
		if (selected === null) return;
		const next = this.corners()
			.filter((_, index) => index !== selected)
			.map((corner, index) => ({ ...corner, order: index + 1 }));
		this.corners.set(next);
		this.selectedCorner.set(
			next.length ? Math.min(selected, next.length - 1) : null,
		);
	}

	protected selectCorner(key: string): void {
		const index = this.corners().findIndex((corner) => corner.key === key);
		if (index >= 0) this.selectedCorner.set(index);
	}
	protected selectPoint(target: PointTarget): void {
		this.selectedPoint.set(target);
	}
	protected selectCornerEvent(event: Event): void {
		if (event.target instanceof HTMLSelectElement)
			this.selectCorner(event.target.value);
	}
	protected selectPointEvent(event: Event): void {
		if (event.target instanceof HTMLSelectElement)
			this.selectPoint(event.target.value as PointTarget);
	}

	protected setName(event: Event): void {
		const value = this.inputValue(event);
		this.updateActive((corner) => ({ ...corner, name: value }));
	}

	protected setKey(event: Event): void {
		const value = this.inputValue(event)
			.toLowerCase()
			.replace(/[^a-z0-9-]/g, '-');
		this.updateActive((corner) => ({ ...corner, key: value }));
	}

	protected setCoordinate(
		event: Event,
		target: PointTarget,
		axis: keyof Point,
	): void {
		const value = Number(this.inputValue(event));
		this.updatePoint(target, axis, value);
	}

	protected setViewCoordinate(
		event: Event,
		axis: keyof TrackCorner['cornerView'],
	): void {
		const value = Number(this.inputValue(event));
		this.updateActive((corner) => ({
			...corner,
			cornerView: {
				...corner.cornerView,
				[axis]: Math.min(1, Math.max(0, value)),
			},
		}));
	}

	protected moveSelected(event: KeyboardEvent): void {
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
		const point = this.activePoint();
		if (!point) return;
		this.updatePoint(this.selectedPoint(), 'x', point.x + change.x);
		this.updatePoint(this.selectedPoint(), 'y', point.y + change.y);
	}

	protected moveFromCanvas(event: MouseEvent): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLElement)) return;
		const bounds = target.getBoundingClientRect();
		const x = Math.min(
			1,
			Math.max(0, (event.clientX - bounds.left) / bounds.width),
		);
		const y = Math.min(
			1,
			Math.max(0, (event.clientY - bounds.top) / bounds.height),
		);
		this.updatePoint(this.selectedPoint(), 'x', x);
		this.updatePoint(this.selectedPoint(), 'y', y);
	}

	protected saveDraft(): void {
		if (!this.errors().length) this.saveRequested.emit(this.corners());
	}
	protected point(corner: TrackCorner, target: PointTarget): Point {
		if (target === 'entryStart') return corner.entryGate.start;
		if (target === 'entryEnd') return corner.entryGate.end;
		if (target === 'exitStart') return corner.exitGate.start;
		return corner.exitGate.end;
	}
	protected svgX(point: Point): number {
		return point.x * 640;
	}
	protected svgY(point: Point): number {
		return point.y * 360;
	}

	private activePoint(): Point | null {
		const corner = this.activeCorner();
		return corner ? this.point(corner, this.selectedPoint()) : null;
	}
	private inputValue(event: Event): string {
		return event.target instanceof HTMLInputElement ? event.target.value : '';
	}
	private updatePoint(
		target: PointTarget,
		axis: keyof Point,
		value: number,
	): void {
		this.updateActive((corner) => {
			const current = this.point(corner, target);
			const next = { ...current, [axis]: Math.min(1, Math.max(0, value)) };
			if (target === 'entryStart')
				return { ...corner, entryGate: { ...corner.entryGate, start: next } };
			if (target === 'entryEnd')
				return { ...corner, entryGate: { ...corner.entryGate, end: next } };
			if (target === 'exitStart')
				return { ...corner, exitGate: { ...corner.exitGate, start: next } };
			return { ...corner, exitGate: { ...corner.exitGate, end: next } };
		});
	}
	private updateActive(update: (corner: TrackCorner) => TrackCorner): void {
		const selected = this.selectedCorner();
		if (selected === null) return;
		this.corners.set(
			this.corners().map((corner, index) =>
				index === selected ? update(corner) : corner,
			),
		);
	}
}
