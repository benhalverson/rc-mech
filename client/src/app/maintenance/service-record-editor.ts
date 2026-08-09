import { DOCUMENT } from '@angular/common';
import {
	afterNextRender,
	Component,
	effect,
	Injector,
	inject,
	input,
	linkedSignal,
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
import type { MaintenancePlan, ServiceRecord } from './maintenance.models';
import { localDateTime, localDateTimeToIso } from './maintenance-plan.rules';
import {
	type ServiceRecordFailure,
	ServiceRecordStore,
} from './service-record-store';

export type ServiceRecordEditorRequest =
	| { readonly kind: 'create' }
	| { readonly kind: 'edit'; readonly record: ServiceRecord }
	| { readonly kind: 'complete'; readonly plan: MaintenancePlan };

export type ServiceRecordForm = {
	carId: string;
	componentId: string;
	performedAt: string;
	description: string;
	notes: string;
	cost: string;
	currency: string;
};

const emptyForm = (): ServiceRecordForm => ({
	carId: '',
	componentId: '',
	performedAt: '',
	description: '',
	notes: '',
	cost: '',
	currency: 'USD',
});

@Component({
	selector: 'app-service-record-editor',
	imports: [FormField, LucideSave, LucideTriangleAlert],
	templateUrl: './service-record-editor.html',
	host: { class: 'contents' },
})
export class ServiceRecordEditor {
	private readonly store = inject(ServiceRecordStore);
	private readonly document = inject(DOCUMENT);
	private readonly injector = inject(Injector);
	private readonly returnFocusSelector = signal(
		'[data-maintenance-launcher="service"]',
	);
	private readonly handledOperationId = signal(0);

	readonly request = input<ServiceRecordEditorRequest | null>(null);
	readonly cancelled = output<void>();
	readonly saved = output<void>();

	protected readonly garage = linkedSignal(() => this.store.cars());
	protected readonly timezone = this.store.timezone;
	protected readonly components = this.store.components;
	protected readonly action = this.store.action;
	protected readonly error = signal('');
	protected readonly form = signal<ServiceRecordForm>(emptyForm());
	protected readonly fields = signalForm(this.form, (path) => {
		required(path.carId, { message: 'Choose a car.' });
		required(path.performedAt, { message: 'Add the completion date.' });
		required(path.description, { message: 'Describe the completed work.' });
		validate(path.description, ({ value }) =>
			!value() || value().trim()
				? undefined
				: {
						kind: 'blankDescription',
						message: 'Describe the completed work.',
					},
		);
		maxLength(path.description, 4000, {
			message: 'Use 4,000 characters or fewer for completed work.',
		});
		maxLength(path.notes, 4000, {
			message: 'Use 4,000 characters or fewer for notes.',
		});
		maxLength(path.currency, 3, {
			message: 'Use a three-letter currency code.',
		});
		validate(path.cost, ({ value }) =>
			!value().trim() ||
			(Number.isFinite(Number(value())) && Number(value()) >= 0)
				? undefined
				: { kind: 'cost', message: 'Cost must be zero or greater.' },
		);
		validate(path.currency, ({ value }) =>
			!value().trim() || /^[A-Za-z]{3}$/.test(value().trim())
				? undefined
				: {
						kind: 'currency',
						message: 'Use a three-letter currency code.',
					},
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
			if (outcome.command.kind !== 'save-service') return;
			if (outcome.status === 'failed') {
				this.error.set(this.failureMessage(outcome.failure));
				return;
			}
			this.returnFocusSelector.set('#maintenance-title');
			this.close(this.saved);
		});
	}

	protected cancel(): void {
		this.close(this.cancelled);
	}

	protected changeCar(event: Event): void {
		if (!(event.target instanceof HTMLSelectElement)) return;
		const carId = event.target.value;
		this.form.update((current) => ({ ...current, carId }));
		this.store.loadComponents(carId);
	}

	protected save(event: Event): void {
		event.preventDefault();
		this.fields().markAsTouched();
		const form = this.form();
		const cost = form.cost.trim() ? Number(form.cost) : null;
		if (this.fields().invalid()) {
			this.error.set(
				this.fields().errorSummary()[0]?.message ??
					'Review the service record fields.',
			);
			if (this.fields.carId().invalid())
				this.fields.carId().focusBoundControl();
			else if (this.fields.performedAt().invalid())
				this.fields.performedAt().focusBoundControl();
			else if (this.fields.description().invalid())
				this.fields.description().focusBoundControl();
			else if (this.fields.cost().invalid())
				this.fields.cost().focusBoundControl();
			else if (this.fields.currency().invalid())
				this.fields.currency().focusBoundControl();
			else this.fields.notes().focusBoundControl();
			return;
		}
		if (cost !== null && (!Number.isFinite(cost) || cost < 0)) {
			this.error.set('Cost must be zero or greater.');
			return;
		}
		if (this.action()) return;
		const request = this.request();
		if (!request) return;
		const service = {
			performedAt: localDateTimeToIso(form.performedAt, this.timezone()),
			description: form.description.trim(),
			...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
			componentId: form.componentId || undefined,
			...(cost === null
				? {}
				: { cost, currency: form.currency.trim().toUpperCase() || 'USD' }),
		};
		this.error.set('');
		this.store.mutate({
			kind: 'save-service',
			mode: request.kind,
			carId: form.carId,
			id:
				request.kind === 'edit'
					? request.record.id
					: request.kind === 'complete'
						? request.plan.id
						: null,
			service,
		});
	}

	private open(request: ServiceRecordEditorRequest): void {
		if (request.kind === 'create') {
			const firstCar = this.garage().find((car) => !car.archivedAt);
			if (!firstCar) {
				this.cancelled.emit();
				return;
			}
			this.returnFocusSelector.set('[data-maintenance-launcher="service"]');
			this.fields().reset({
				...emptyForm(),
				carId: firstCar.id,
				performedAt: localDateTime(new Date(), this.timezone()),
			});
			this.store.loadComponents(firstCar.id);
		} else if (request.kind === 'edit') {
			const record = request.record;
			if (this.isReadOnly(record)) {
				this.cancelled.emit();
				return;
			}
			this.returnFocusSelector.set(
				`[data-maintenance-launcher="record:${record.id}"]`,
			);
			this.fields().reset({
				carId: record.carId,
				componentId: record.componentId ?? '',
				performedAt: localDateTime(
					new Date(record.performedAt),
					this.timezone(),
				),
				description: record.description,
				notes: record.notes ?? '',
				cost: record.cost == null ? '' : String(record.cost),
				currency: record.currency ?? 'USD',
			});
			this.store.loadComponents(record.carId);
		} else {
			const plan = request.plan;
			this.returnFocusSelector.set(
				`[data-maintenance-launcher="complete:${plan.id}"]`,
			);
			this.fields().reset({
				...emptyForm(),
				carId: plan.carId,
				componentId: plan.componentId ?? '',
				performedAt: localDateTime(new Date(), this.timezone()),
				description: `Completed ${plan.name}`,
			});
			this.store.loadComponents(plan.carId);
		}
		this.error.set('');
		this.focusAfterRender('#service-form-title');
	}

	private close(intent: { emit(): void }): void {
		this.error.set('');
		this.fields().reset();
		intent.emit();
		this.focusAfterRender(this.returnFocusSelector());
	}

	private failureMessage(failure: ServiceRecordFailure): string {
		return failure === 'session-expired'
			? 'Your garage session has expired. Sign in again to continue.'
			: failure === 'car-archived'
				? 'This car is archived. Restore it before recording service.'
				: 'The service record could not be saved.';
	}

	private isReadOnly(record: ServiceRecord): boolean {
		return (
			Boolean(
				this.garage().find((car) => car.id === record.carId)?.archivedAt,
			) || Boolean(record.deletedAt)
		);
	}

	private focusAfterRender(selector: string): void {
		afterNextRender(
			() => this.document.querySelector<HTMLElement>(selector)?.focus(),
			{ injector: this.injector },
		);
	}
}
