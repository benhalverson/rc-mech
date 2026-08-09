import { DOCUMENT } from '@angular/common';
import {
	afterNextRender,
	Component,
	computed,
	effect,
	Injector,
	inject,
	input,
	output,
	signal,
	untracked,
} from '@angular/core';
import {
	FormField,
	maxLength,
	required,
	form as signalForm,
	validate,
} from '@angular/forms/signals';
import { LucideSave, LucideTriangleAlert } from '@lucide/angular';
import type { ConsumableEntry } from '../maintenance.models';
import { consumableEntryIsReadOnly } from './consumable.rules';
import {
	type ConsumableEntryForm,
	emptyConsumableEntryForm,
	existingConsumableEntryForm,
	hasConsumableTireSnapshot,
	mapConsumableSaveCommand,
	newConsumableEntryForm,
	parseConsumableCost,
} from './consumable-entry.rules';
import { type ConsumableFailure, ConsumableStore } from './consumable-store';

export type { ConsumableEntryForm } from './consumable-entry.rules';

export type ConsumableEntryEditorRequest =
	| { readonly kind: 'create' }
	| { readonly kind: 'edit'; readonly entry: ConsumableEntry };

@Component({
	selector: 'app-consumable-entry-editor',
	imports: [FormField, LucideSave, LucideTriangleAlert],
	templateUrl: './consumable-entry-editor.html',
	host: { class: 'contents' },
})
export class ConsumableEntryEditor {
	private readonly store = inject(ConsumableStore);
	private readonly document = inject(DOCUMENT);
	private readonly injector = inject(Injector);
	private readonly handledOperationId = signal(
		this.store.outcome().operationId ?? 0,
	);
	private readonly returnFocusSelector = signal(
		'[data-consumable-launcher="record"]',
	);

	readonly request = input<ConsumableEntryEditorRequest | null>(null);
	readonly cancelled = output<void>();
	readonly saved = output<void>();

	protected readonly garage = computed(() => this.store.cars());
	protected readonly timezone = this.store.timezone;
	protected readonly action = this.store.action;
	protected readonly formError = signal('');
	protected readonly form = signal<ConsumableEntryForm>(
		emptyConsumableEntryForm(),
	);
	protected readonly entryFields = signalForm(this.form, (path) => {
		required(path.carId, { message: 'Choose a car.' });
		required(path.performedAt, { message: 'Add the change date.' });
		maxLength(path.notes, 4000, {
			message: 'Use 4,000 characters or fewer for notes.',
		});
		for (const cost of [path.frontCost, path.rearCost])
			validate(cost, ({ value }) =>
				parseConsumableCost(value()) !== 'invalid'
					? undefined
					: { kind: 'cost', message: 'Costs must be zero or greater.' },
			);
		validate(path.frontDetails, (context) =>
			context.valueOf(path.kind) === 'tires' &&
			context.valueOf(path.axle) !== 'rear' &&
			!hasConsumableTireSnapshot(
				context.value(),
				context.valueOf(path.frontCost),
			)
				? {
						kind: 'tireDetailsRequired',
						message: 'Add front tire details or cost.',
					}
				: undefined,
		);
		validate(path.rearDetails, (context) =>
			context.valueOf(path.kind) === 'tires' &&
			context.valueOf(path.axle) !== 'front' &&
			!hasConsumableTireSnapshot(
				context.value(),
				context.valueOf(path.rearCost),
			)
				? {
						kind: 'tireDetailsRequired',
						message: 'Add rear tire details or cost.',
					}
				: undefined,
		);
	});

	constructor() {
		effect(() => {
			const request = this.request();
			if (request) untracked(() => this.open(request));
		});
		effect(() => {
			const outcome = this.store.outcome();
			if (
				outcome.status === 'idle' ||
				outcome.status === 'pending' ||
				outcome.operationId === this.handledOperationId()
			)
				return;
			this.handledOperationId.set(outcome.operationId);
			if (outcome.command.kind !== 'save') return;
			if (outcome.status === 'failed') {
				this.formError.set(this.failureMessage(outcome.failure));
				return;
			}
			this.returnFocusSelector.set('#consumable-title');
			this.close(this.saved);
		});
		effect(() => {
			const lookup = this.store.tireLookup();
			const currentForm = untracked(this.form);
			if (
				lookup.status !== 'succeeded' ||
				lookup.carId !== currentForm.carId ||
				!lookup.tires
			)
				return;
			const details = Object.entries(lookup.tires)
				.map(([key, value]) => `${key}: ${String(value)}`)
				.join('\n');
			untracked(() =>
				this.form.update((current) => ({
					...current,
					frontDetails: current.frontDetails || details,
					rearDetails: current.rearDetails || details,
				})),
			);
		});
	}

	protected cancel(): void {
		this.close(this.cancelled);
	}

	protected changeKind(event: Event): void {
		if (!(event.target instanceof HTMLSelectElement)) return;
		const kind = event.target.value as ConsumableEntryForm['kind'];
		this.form.update((current) => ({
			...current,
			kind,
		}));
		this.applyKindChange();
	}

	protected save(event: Event): void {
		event.preventDefault();
		this.entryFields().markAsTouched();
		const form = this.form();
		if (this.entryFields().invalid()) {
			this.formError.set(
				this.entryFields().errorSummary()[0]?.message ??
					'Review the consumable history fields.',
			);
			if (this.entryFields.carId().invalid())
				this.entryFields.carId().focusBoundControl();
			else if (this.entryFields.performedAt().invalid())
				this.entryFields.performedAt().focusBoundControl();
			else if (this.entryFields.frontDetails().invalid())
				this.entryFields.frontDetails().focusBoundControl();
			else if (this.entryFields.rearDetails().invalid())
				this.entryFields.rearDetails().focusBoundControl();
			else if (this.entryFields.frontCost().invalid())
				this.entryFields.frontCost().focusBoundControl();
			else if (this.entryFields.rearCost().invalid())
				this.entryFields.rearCost().focusBoundControl();
			else this.entryFields.notes().focusBoundControl();
			return;
		}
		if (this.action()) return;
		const request = this.request();
		if (!request) return;
		const mapping = mapConsumableSaveCommand(
			form,
			this.timezone(),
			request.kind === 'edit' ? 'edit' : 'create',
			request.kind === 'edit' ? request.entry.id : null,
		);
		if (!mapping.ok) {
			this.formError.set(mapping.message);
			return;
		}
		this.formError.set('');
		this.store.mutate(mapping.command);
	}

	private open(request: ConsumableEntryEditorRequest): void {
		if (request.kind === 'create') {
			const car = this.garage().find((item) => !item.archivedAt);
			if (!car) {
				this.cancelled.emit();
				return;
			}
			this.returnFocusSelector.set('[data-consumable-launcher="record"]');
			this.entryFields().reset(
				newConsumableEntryForm(car.id, this.timezone(), new Date()),
			);
		} else {
			const entry = request.entry;
			if (consumableEntryIsReadOnly(entry, this.garage())) {
				this.cancelled.emit();
				return;
			}
			this.returnFocusSelector.set(
				`[data-consumable-launcher="entry:${entry.id}"]`,
			);
			this.entryFields().reset(
				existingConsumableEntryForm(entry, this.timezone()),
			);
		}
		this.formError.set('');
		this.focusAfterRender('#consumable-form-title');
	}

	private applyKindChange(): void {
		if (this.form().kind !== 'tires') {
			this.form.update((current) => ({
				...current,
				axle: 'front',
				rearDetails: '',
				rearCost: '',
			}));
			return;
		}
		this.store.loadTires(this.form().carId);
	}

	private failureMessage(failure: ConsumableFailure): string {
		return failure === 'car-archived'
			? 'This car is archived. Restore it before recording maintenance.'
			: 'The consumable entry could not be saved.';
	}

	private close(intent: { emit(): void }): void {
		this.formError.set('');
		this.entryFields().reset();
		intent.emit();
		this.focusAfterRender(this.returnFocusSelector());
	}

	private focusAfterRender(selector: string): void {
		afterNextRender(
			() => this.document.querySelector<HTMLElement>(selector)?.focus(),
			{ injector: this.injector },
		);
	}
}
