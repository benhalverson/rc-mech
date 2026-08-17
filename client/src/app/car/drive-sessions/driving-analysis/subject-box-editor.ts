import {
	Component,
	computed,
	ElementRef,
	input,
	model,
	signal,
	viewChild,
} from '@angular/core';
import type { SubjectBox } from './driving-analysis.models';

type BoxField = keyof SubjectBox;
type DragStart = Readonly<{ pointerId: number; x: number; y: number }>;

const MIN_BOX_SIZE = 0.005;
const round = (value: number): number =>
	Math.round(value * 1_000_000) / 1_000_000;
const clamp = (value: number, minimum: number, maximum: number): number =>
	round(Math.min(maximum, Math.max(minimum, value)));
const percent = (value: number): string => `${round(value * 100)}%`;

@Component({
	selector: 'app-subject-box-editor',
	templateUrl: './subject-box-editor.html',
	host: { class: 'block' },
})
export class SubjectBoxEditor {
	readonly editorId = input.required<string>();
	readonly box = model.required<SubjectBox>();
	readonly valid = model(true);
	private readonly surface =
		viewChild.required<ElementRef<HTMLElement>>('surface');
	private readonly drag = signal<DragStart | null>(null);
	private readonly invalidFields = signal<readonly BoxField[]>([]);

	protected readonly description = computed(() => {
		const box = this.box();
		return `Subject box: ${percent(box.x)} from the left, ${percent(box.y)} from the top, ${percent(box.width)} wide, and ${percent(box.height)} high in the Track view.`;
	});

	protected pointerDown(event: PointerEvent): void {
		if (event.button !== 0) return;
		const point = this.point(event);
		if (!point) return;
		event.preventDefault();
		this.surface().nativeElement.setPointerCapture(event.pointerId);
		const start = {
			x: Math.min(point.x, 1 - MIN_BOX_SIZE),
			y: Math.min(point.y, 1 - MIN_BOX_SIZE),
		};
		this.drag.set({ pointerId: event.pointerId, ...start });
		this.accept({
			...start,
			width: MIN_BOX_SIZE,
			height: MIN_BOX_SIZE,
		});
	}

	protected pointerMove(event: PointerEvent): void {
		const drag = this.drag();
		if (!drag || drag.pointerId !== event.pointerId) return;
		const point = this.point(event);
		if (!point) return;
		event.preventDefault();
		const x = Math.min(drag.x, point.x);
		const y = Math.min(drag.y, point.y);
		this.accept({
			x: round(x),
			y: round(y),
			width: clamp(Math.abs(point.x - drag.x), MIN_BOX_SIZE, 1 - x),
			height: clamp(Math.abs(point.y - drag.y), MIN_BOX_SIZE, 1 - y),
		});
	}

	protected pointerUp(event: PointerEvent): void {
		const drag = this.drag();
		if (!drag || drag.pointerId !== event.pointerId) return;
		this.surface().nativeElement.releasePointerCapture(event.pointerId);
		this.drag.set(null);
	}

	protected move(event: KeyboardEvent): void {
		const delta = event.shiftKey ? 0.01 : 0.002;
		const movement: Record<string, Readonly<{ x: number; y: number }>> = {
			ArrowLeft: { x: -delta, y: 0 },
			ArrowRight: { x: delta, y: 0 },
			ArrowUp: { x: 0, y: -delta },
			ArrowDown: { x: 0, y: delta },
		};
		const change = movement[event.key];
		if (!change) return;
		event.preventDefault();
		const box = this.box();
		this.accept({
			...box,
			x: clamp(box.x + change.x, 0, 1 - box.width),
			y: clamp(box.y + change.y, 0, 1 - box.height),
		});
	}

	protected update(field: BoxField, event: Event): void {
		const target = event.target as HTMLInputElement;
		if (!Number.isFinite(target.valueAsNumber)) {
			this.invalidFields.update((fields) =>
				fields.includes(field) ? fields : [...fields, field],
			);
			this.valid.set(false);
			return;
		}
		const value = target.valueAsNumber;
		const box = this.box();
		const next = { ...box };
		switch (field) {
			case 'x':
				next.x = clamp(value, 0, 1 - box.width);
				break;
			case 'y':
				next.y = clamp(value, 0, 1 - box.height);
				break;
			case 'width':
				next.width = clamp(value, MIN_BOX_SIZE, 1 - box.x);
				break;
			case 'height':
				next.height = clamp(value, MIN_BOX_SIZE, 1 - box.y);
				break;
		}
		this.box.set(next);
		this.invalidFields.update((fields) =>
			fields.filter((candidate) => candidate !== field),
		);
		this.valid.set(this.invalidFields().length === 0);
	}

	protected fieldInvalid(field: BoxField): boolean {
		return this.invalidFields().includes(field);
	}

	private accept(box: SubjectBox): void {
		this.box.set(box);
		this.invalidFields.set([]);
		this.valid.set(true);
	}

	private point(event: PointerEvent): { x: number; y: number } | null {
		const bounds = this.surface().nativeElement.getBoundingClientRect();
		if (bounds.width <= 0 || bounds.height <= 0) return null;
		return {
			x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
			y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1),
		};
	}
}
