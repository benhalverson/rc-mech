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
import type {
	ConsumableEntry,
	ConsumableMaintenanceDraft,
	FluidArea,
	TireAxle,
} from '../maintenance.models';
import { localDateTime, localDateTimeToIso } from '../maintenance-time';
import { consumableEntryIsReadOnly } from './consumable.rules';
import { type ConsumableFailure, ConsumableStore } from './consumable-store';

export type ConsumableEntryEditorRequest =
	| { readonly kind: 'create' }
	| { readonly kind: 'edit'; readonly entry: ConsumableEntry };

export type ConsumableEntryForm = {
	carId: string;
	kind: 'shock-fluid' | 'differential-fluid' | 'tires';
	performedAt: string;
	fluidArea: FluidArea;
	customArea: string;
	axle: TireAxle;
	frontDetails: string;
	rearDetails: string;
	frontCost: string;
	rearCost: string;
	notes: string;
};

const emptyForm = (): ConsumableEntryForm => ({
	carId: '',
	kind: 'shock-fluid',
	performedAt: '',
	fluidArea: 'front-shocks',
	customArea: '',
	axle: 'front',
	frontDetails: '',
	rearDetails: '',
	frontCost: '',
	rearCost: '',
	notes: '',
});

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
	protected readonly form = signal<ConsumableEntryForm>(emptyForm());
	protected readonly entryFields = signalForm(this.form, (path) => {
		required(path.carId, { message: 'Choose a car.' });
		required(path.performedAt, { message: 'Add the change date.' });
		maxLength(path.notes, 4000, {
			message: 'Use 4,000 characters or fewer for notes.',
		});
		for (const cost of [path.frontCost, path.rearCost])
			validate(cost, ({ value }) =>
				!value().trim() ||
				(Number.isFinite(Number(value())) && Number(value()) >= 0)
					? undefined
					: { kind: 'cost', message: 'Costs must be zero or greater.' },
			);
		validate(path.frontDetails, (context) =>
			context.valueOf(path.kind) === 'tires' &&
			context.valueOf(path.axle) !== 'rear' &&
			!context.value().trim() &&
			!context.valueOf(path.frontCost).trim()
				? {
						kind: 'tireDetailsRequired',
						message: 'Add front tire details or cost.',
					}
				: undefined,
		);
		validate(path.rearDetails, (context) =>
			context.valueOf(path.kind) === 'tires' &&
			context.valueOf(path.axle) !== 'front' &&
			!context.value().trim() &&
			!context.valueOf(path.rearCost).trim()
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
		if (
			form.kind === 'tires' &&
			((form.axle !== 'rear' &&
				!form.frontDetails.trim() &&
				!form.frontCost.trim()) ||
				(form.axle !== 'front' &&
					!form.rearDetails.trim() &&
					!form.rearCost.trim()))
		) {
			this.formError.set('Add front or rear tire details before saving.');
			return;
		}
		const frontCost = this.optionalCost(form.frontCost);
		const rearCost = this.optionalCost(form.rearCost);
		if (frontCost === 'invalid' || rearCost === 'invalid') {
			this.formError.set('Costs must be zero or greater.');
			return;
		}
		if (this.action()) return;
		const request = this.request();
		if (!request) return;
		const maintenance: ConsumableMaintenanceDraft =
			form.kind === 'tires'
				? {
						kind: form.kind,
						performedAt: localDateTimeToIso(form.performedAt, this.timezone()),
						axle: form.axle,
						...(form.axle !== 'rear' && form.frontDetails.trim()
							? { frontDetails: form.frontDetails.trim() }
							: {}),
						...(form.axle !== 'rear' && frontCost !== null
							? { frontCost }
							: {}),
						...(form.axle !== 'front' && form.rearDetails.trim()
							? { rearDetails: form.rearDetails.trim() }
							: {}),
						...(form.axle !== 'front' && rearCost !== null ? { rearCost } : {}),
						...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
					}
				: {
						kind: form.kind,
						performedAt: localDateTimeToIso(form.performedAt, this.timezone()),
						fluidArea: form.fluidArea,
						...(form.fluidArea === 'custom' && form.customArea.trim()
							? { customArea: form.customArea.trim() }
							: {}),
						...(frontCost !== null ? { cost: frontCost } : {}),
						...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
					};
		this.formError.set('');
		this.store.mutate({
			kind: 'save',
			mode: request.kind === 'edit' ? 'edit' : 'create',
			carId: form.carId,
			id: request.kind === 'edit' ? request.entry.id : null,
			maintenance,
		});
	}

	private open(request: ConsumableEntryEditorRequest): void {
		if (request.kind === 'create') {
			const car = this.garage().find((item) => !item.archivedAt);
			if (!car) {
				this.cancelled.emit();
				return;
			}
			this.returnFocusSelector.set('[data-consumable-launcher="record"]');
			this.entryFields().reset({
				...emptyForm(),
				carId: car.id,
				performedAt: localDateTime(new Date(), this.timezone()),
			});
		} else {
			const entry = request.entry;
			if (consumableEntryIsReadOnly(entry, this.garage())) {
				this.cancelled.emit();
				return;
			}
			this.returnFocusSelector.set(
				`[data-consumable-launcher="entry:${entry.id}"]`,
			);
			this.entryFields().reset({
				...emptyForm(),
				carId: entry.carId,
				kind: entry.kind,
				performedAt: localDateTime(
					new Date(entry.performedAt),
					this.timezone(),
				),
				fluidArea: entry.fluidArea ?? 'front-shocks',
				customArea: entry.customArea ?? '',
				axle: entry.axle ?? 'front',
				frontDetails: entry.frontDetails ?? '',
				rearDetails: entry.rearDetails ?? '',
				frontCost:
					entry.kind === 'tires'
						? entry.frontCost == null
							? ''
							: String(entry.frontCost)
						: entry.cost == null
							? ''
							: String(entry.cost),
				rearCost: entry.rearCost == null ? '' : String(entry.rearCost),
				notes: entry.notes ?? '',
			});
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

	private optionalCost(value: string): number | null | 'invalid' {
		if (!value.trim()) return null;
		const number = Number(value);
		return Number.isFinite(number) && number >= 0 ? number : 'invalid';
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
