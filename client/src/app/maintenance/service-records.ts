import { CommonModule, DatePipe, DOCUMENT } from '@angular/common';
import {
	afterNextRender,
	Component,
	computed,
	effect,
	Injector,
	inject,
	input,
	linkedSignal,
	output,
	signal,
} from '@angular/core';
import {
	FormField,
	maxLength,
	required,
	form as signalForm,
	validate,
} from '@angular/forms/signals';
import {
	LucideArchive,
	LucideArchiveRestore,
	LucidePencil,
	LucideRotateCcw,
	LucideSave,
	LucideTriangleAlert,
	LucideWrench,
} from '@lucide/angular';
import { localDateTime, localDateTimeToIso } from './maintenance-plan.rules';
import type {
	MaintenanceActivity,
	MaintenanceGatewayFailure,
	MaintenancePlan,
	ServiceRecord,
} from './maintenance.models';
import {
	type ServiceRecordCommand,
	ServiceRecordStore,
} from './service-record-store';

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
	selector: 'app-service-records',
	imports: [
		CommonModule,
		DatePipe,
		FormField,
		LucideArchive,
		LucideArchiveRestore,
		LucidePencil,
		LucideRotateCcw,
		LucideSave,
		LucideTriangleAlert,
		LucideWrench,
	],
	templateUrl: './service-records.html',
	host: { class: 'contents' },
})
export class ServiceRecords {
	private readonly store = inject(ServiceRecordStore);
	private readonly document = inject(DOCUMENT);
	private readonly injector = inject(Injector);
	private returnFocusSelector = '[data-maintenance-launcher="service"]';
	private openedCompletionId: string | null = null;

	readonly siblingEditing = input(false);
	readonly completionPlan = input<MaintenancePlan | null>(null);
	readonly editingChange = output<boolean>();
	readonly completionClosed = output<void>();

	protected readonly garage = linkedSignal(() => this.store.cars());
	protected readonly records = linkedSignal(() => this.store.records());
	protected readonly activity = this.store.activity;
	protected readonly timezone = this.store.timezone;
	protected readonly components = this.store.components;
	protected readonly editing = signal(false);
	protected readonly editingId = signal<string | null>(null);
	protected readonly planId = signal<string | null>(null);
	protected readonly error = signal('');
	protected readonly mutationError = signal('');
	protected readonly action = this.store.action;
	protected readonly historyFilter = signal<'active' | 'deleted'>('active');
	protected readonly form = signal<ServiceRecordForm>(emptyForm());
	protected readonly fields = signalForm(this.form, (path) => {
		required(path.carId, { message: 'Choose a car.' });
		required(path.performedAt, { message: 'Add the completion date.' });
		required(path.description, {
			message: 'Describe the completed work.',
		});
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
	protected readonly visibleRecords = computed(() =>
		this.records().filter((record) =>
			this.historyFilter() === 'deleted'
				? Boolean(record.deletedAt)
				: !record.deletedAt,
		),
	);
	protected readonly totals = computed(() => {
		const totals = new Map<string, number>();
		for (const record of this.visibleRecords()) {
			if (record.cost !== null && record.cost !== undefined) {
				const currency = record.currency ?? 'USD';
				totals.set(currency, (totals.get(currency) ?? 0) + record.cost);
			}
		}
		return [...totals.entries()].map(([currency, total]) => ({
			currency,
			total,
		}));
	});

	constructor() {
		let handledOperationId = 0;
		effect(() => {
			const outcome = this.store.outcome();
			if (
				outcome.status === 'idle' ||
				outcome.status === 'pending' ||
				outcome.operationId === handledOperationId
			)
				return;
			handledOperationId = outcome.operationId;
			if (outcome.status === 'failed') {
				this.handleFailure(outcome.command, outcome.error);
				return;
			}
			if (outcome.command.kind === 'save-service') {
				this.returnFocusSelector = '#maintenance-title';
				this.cancelEdit();
			}
		});
		effect(() => {
			const plan = this.completionPlan();
			if (!plan || plan.id === this.openedCompletionId) return;
			this.openedCompletionId = plan.id;
			this.openCompletion(plan);
		});
	}

	openCreate(): void {
		const firstCar = this.garage().find((car) => !car.archivedAt);
		if (!firstCar) return;
		this.returnFocusSelector = '[data-maintenance-launcher="service"]';
		this.fields().reset({
			...emptyForm(),
			carId: firstCar.id,
			performedAt: localDateTime(new Date(), this.timezone()),
		});
		this.editingId.set(null);
		this.planId.set(null);
		this.error.set('');
		this.store.loadComponents(firstCar.id);
		this.beginEditing();
	}

	protected openEdit(record: ServiceRecord): void {
		if (this.isReadOnly(record)) return;
		this.returnFocusSelector = `[data-maintenance-launcher="record:${record.id}"]`;
		this.fields().reset({
			carId: record.carId,
			componentId: record.componentId ?? '',
			performedAt: localDateTime(new Date(record.performedAt), this.timezone()),
			description: record.description,
			notes: record.notes ?? '',
			cost: record.cost == null ? '' : String(record.cost),
			currency: record.currency ?? 'USD',
		});
		this.editingId.set(record.id);
		this.planId.set(record.planId ?? null);
		this.error.set('');
		this.store.loadComponents(record.carId);
		this.beginEditing();
	}

	private openCompletion(plan: MaintenancePlan): void {
		this.returnFocusSelector = `[data-maintenance-launcher="complete:${plan.id}"]`;
		this.fields().reset({
			...emptyForm(),
			carId: plan.carId,
			componentId: plan.componentId ?? '',
			performedAt: localDateTime(new Date(), this.timezone()),
			description: `Completed ${plan.name}`,
		});
		this.editingId.set(null);
		this.planId.set(plan.id);
		this.error.set('');
		this.store.loadComponents(plan.carId);
		this.beginEditing();
	}

	private beginEditing(): void {
		this.editing.set(true);
		this.editingChange.emit(true);
		this.focusAfterRender('#service-form-title');
	}

	protected cancelEdit(): void {
		const wasCompletion = this.planId() !== null && this.editingId() === null;
		this.editing.set(false);
		this.editingId.set(null);
		this.planId.set(null);
		this.error.set('');
		this.fields().reset();
		this.editingChange.emit(false);
		if (wasCompletion) {
			this.openedCompletionId = null;
			this.completionClosed.emit();
		}
		this.focusAfterRender(this.returnFocusSelector);
	}

	protected changeCar(event: Event): void {
		if (!(event.target instanceof HTMLSelectElement)) return;
		const carId = event.target.value;
		this.form.update((current) => ({ ...current, carId }));
		this.store.loadComponents(carId);
	}

	protected setHistoryFilter(value: 'active' | 'deleted'): void {
		this.historyFilter.set(value);
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
		const service = {
			performedAt: localDateTimeToIso(form.performedAt, this.timezone()),
			description: form.description.trim(),
			...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
			componentId: form.componentId || undefined,
			...(cost === null
				? {}
				: { cost, currency: form.currency.trim().toUpperCase() || 'USD' }),
		};
		const recordId = this.editingId();
		const planId = this.planId();
		this.error.set('');
		this.store.mutate({
			kind: 'save-service',
			mode: recordId ? 'edit' : planId ? 'complete' : 'create',
			carId: form.carId,
			id: recordId ?? planId,
			service,
		});
	}

	protected archive(record: ServiceRecord): void {
		if (this.isReadOnly(record) || this.action()) return;
		this.store.mutate({
			kind: 'change-service',
			recordId: record.id,
			action: 'archive',
		});
	}

	protected restore(record: ServiceRecord): void {
		if (this.action()) return;
		this.store.mutate({
			kind: 'change-service',
			recordId: record.id,
			action: 'restore',
		});
	}

	protected undo(item: MaintenanceActivity): void {
		this.mutationError.set('');
		this.store.mutate({ kind: 'undo-activity', recordId: item.id });
	}

	private handleFailure(
		command: ServiceRecordCommand,
		error: MaintenanceGatewayFailure,
	): void {
		const status = error.kind === 'http' ? error.status : undefined;
		if (command.kind === 'save-service') {
			this.error.set(
				status === 409
					? 'This car is archived. Restore it before recording service.'
					: status === 401
						? 'Your garage session has expired. Sign in again to continue.'
						: 'The service record could not be saved.',
			);
			return;
		}
		if (command.kind === 'change-service') {
			this.error.set(
				command.action === 'archive'
					? 'That service record could not be archived.'
					: 'That service record could not be restored.',
			);
			return;
		}
		this.mutationError.set('That completion could not be undone.');
	}

	protected isReadOnly(record: ServiceRecord): boolean {
		return (
			Boolean(
				this.garage().find((car) => car.id === record.carId)?.archivedAt,
			) || Boolean(record.deletedAt)
		);
	}

	protected carName(carId: string): string {
		return this.garage().find((car) => car.id === carId)?.name ?? 'Unknown car';
	}

	protected componentName(record: ServiceRecord): string {
		return record.componentId
			? (this.components().find(
					(component) => component.id === record.componentId,
				)?.name ?? 'Installed component')
			: 'Garage service';
	}

	protected recordCost(record: ServiceRecord): string {
		return record.cost == null
			? 'No cost logged'
			: `${record.currency ?? 'USD'} ${record.cost.toFixed(2)}`;
	}

	private focusAfterRender(selector: string): void {
		afterNextRender(
			() => this.document.querySelector<HTMLElement>(selector)?.focus(),
			{ injector: this.injector },
		);
	}
}
