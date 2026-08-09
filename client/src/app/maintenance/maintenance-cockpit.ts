import { CommonModule, DatePipe } from '@angular/common';
import {
	afterNextRender,
	Component,
	computed,
	ElementRef,
	effect,
	Injector,
	inject,
	linkedSignal,
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
	LucideCircleCheck,
	LucideClock,
	LucidePencil,
	LucidePlus,
	LucideRefreshCw,
	LucideRotateCcw,
	LucideSave,
	LucideTriangleAlert,
	LucideWrench,
} from '@lucide/angular';
import { ConsumableMaintenance } from './consumables/consumable-maintenance';
import type {
	MaintenanceActivity,
	MaintenanceGatewayFailure,
	MaintenancePlan,
	MaintenancePlanDraft,
	PlanState,
	ServiceRecord,
} from './maintenance.models';
import {
	type MaintenancePlanCommand,
	MaintenancePlanStore,
} from './maintenance-plan-store';
import {
	type ServiceRecordCommand,
	ServiceRecordStore,
} from './service-record-store';

export type {
	MaintenancePlan,
	ServiceRecord,
} from './maintenance.models';

export type MaintenanceForm = {
	carId: string;
	componentId: string;
	name: string;
	calendarValue: string;
	calendarUnit: 'days' | 'weeks' | 'months';
	sessionInterval: string;
	baselineAt: string;
	baselineSessions: string;
};

export type ServiceForm = {
	carId: string;
	componentId: string;
	performedAt: string;
	description: string;
	notes: string;
	cost: string;
	currency: string;
};

const emptyForm = (): MaintenanceForm => ({
	carId: '',
	componentId: '',
	name: '',
	calendarValue: '',
	calendarUnit: 'weeks',
	sessionInterval: '',
	baselineAt: '',
	baselineSessions: '0',
});
const emptyServiceForm = (): ServiceForm => ({
	carId: '',
	componentId: '',
	performedAt: '',
	description: '',
	notes: '',
	cost: '',
	currency: 'USD',
});

export const calendarDays = (
	value: number,
	unit: MaintenanceForm['calendarUnit'],
): number =>
	unit === 'weeks' ? value * 7 : unit === 'months' ? value * 30 : value;

export const calculatePlanState = (
	plan: MaintenancePlan,
	now = new Date(),
	sessionCount = 0,
): PlanState => {
	if (plan.dueStatus) return plan.dueStatus;
	if (plan.status === 'archived') return 'archived';
	if (plan.status === 'paused') return 'paused';
	const baseline = plan.baselineAt
		? new Date(plan.baselineAt).getTime()
		: Number.POSITIVE_INFINITY;
	const calendarDue = plan.intervalDays
		? now.getTime() >= baseline + plan.intervalDays * 86400000
		: false;
	const sessionsDue = plan.intervalSessions
		? sessionCount >= (plan.baselineSessionCount ?? 0) + plan.intervalSessions
		: false;
	if (calendarDue || sessionsDue) {
		const overdue = plan.nextDueAt
			? now.getTime() > new Date(plan.nextDueAt).getTime()
			: calendarDue &&
				now.getTime() > baseline + (plan.intervalDays ?? 0) * 86400000;
		return overdue ? 'overdue' : 'due';
	}
	return 'upcoming';
};

@Component({
	selector: 'app-maintenance-cockpit',
	imports: [
		CommonModule,
		ConsumableMaintenance,
		DatePipe,
		FormField,
		LucideArchive,
		LucideArchiveRestore,
		LucideCircleCheck,
		LucideClock,
		LucidePencil,
		LucidePlus,
		LucideRefreshCw,
		LucideRotateCcw,
		LucideSave,
		LucideTriangleAlert,
		LucideWrench,
	],
	templateUrl: './maintenance-cockpit.html',
	host: { class: 'block' },
})
export class MaintenanceCockpit {
	private readonly planStore = inject(MaintenancePlanStore);
	private readonly serviceStore = inject(ServiceRecordStore);
	private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
	private readonly injector = inject(Injector);
	private returnFocusSelector = '[data-maintenance-launcher="new-plan"]';
	protected readonly garage = linkedSignal(() => this.planStore.cars());
	protected readonly plans = linkedSignal(() => this.planStore.plans());
	protected readonly activity = this.planStore.activity;
	protected readonly serviceRecords = linkedSignal(() =>
		this.serviceStore.records(),
	);
	protected readonly timezone = this.planStore.timezone;
	protected readonly components = computed(() =>
		this.serviceEditing()
			? this.serviceStore.components()
			: this.planStore.components(),
	);
	protected readonly mutationError = signal('');
	protected readonly state = computed(() =>
		this.planStore.loading() || this.serviceStore.loading()
			? 'loading'
			: this.planStore.error() || this.serviceStore.error()
				? 'error'
				: 'ready',
	);
	protected readonly error = computed(
		() => this.planStore.error() || this.serviceStore.error(),
	);
	protected readonly editing = signal(false);
	protected readonly serviceEditing = signal(false);
	protected readonly serviceEditingId = signal<string | null>(null);
	protected readonly servicePlanId = signal<string | null>(null);
	protected readonly editingId = signal<string | null>(null);
	protected readonly action = this.planStore.action;
	protected readonly formError = signal('');
	protected readonly form = signal<MaintenanceForm>(emptyForm());
	protected readonly serviceForm = signal<ServiceForm>(emptyServiceForm());
	protected readonly planFields = signalForm(this.form, (path) => {
		required(path.carId, { message: 'Choose a car.' });
		required(path.name, { message: 'Name the care rule.' });
		validate(path.name, ({ value }) =>
			!value() || value().trim()
				? undefined
				: { kind: 'blankName', message: 'Name the care rule.' },
		);
		maxLength(path.name, 160, {
			message: 'Use 160 characters or fewer for the plan name.',
		});
		for (const interval of [path.calendarValue, path.sessionInterval])
			validate(interval, ({ value }) => {
				const intervalValue = value().trim();
				if (!intervalValue) return undefined;
				if (!/^\d+$/.test(intervalValue))
					return {
						kind: 'wholeNumber',
						message: 'Intervals must be whole numbers.',
					};
				return Number(intervalValue) >= 1
					? undefined
					: { kind: 'minimum', message: 'Intervals must be at least one.' };
			});
		validate(path.calendarValue, (context) =>
			!context.value().trim() && !context.valueOf(path.sessionInterval).trim()
				? {
						kind: 'intervalRequired',
						message:
							'Add a calendar interval, a drive-session threshold, or both.',
					}
				: undefined,
		);
		validate(path.sessionInterval, (context) =>
			!context.value().trim() && !context.valueOf(path.calendarValue).trim()
				? {
						kind: 'intervalRequired',
						message:
							'Add a calendar interval, a drive-session threshold, or both.',
					}
				: undefined,
		);
		validate(path.baselineSessions, ({ value }) =>
			!value().trim() || /^\d+$/.test(value().trim())
				? undefined
				: {
						kind: 'wholeNumber',
						message: 'Prior sessions must be a whole number.',
					},
		);
	});
	protected readonly serviceFields = signalForm(this.serviceForm, (path) => {
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
	protected readonly serviceError = signal('');
	protected readonly serviceAction = this.serviceStore.action;
	protected readonly historyFilter = signal<'active' | 'deleted'>('active');
	protected readonly selectedFilter = signal<'all' | PlanState>('all');
	protected readonly filterOptions: Array<'all' | PlanState> = [
		'all',
		'overdue',
		'due',
		'upcoming',
		'paused',
		'archived',
	];
	protected readonly visiblePlans = computed(() =>
		this.plans().filter(
			(plan) =>
				this.selectedFilter() === 'all' ||
				calculatePlanState(plan) === this.selectedFilter(),
		),
	);
	protected readonly grouped = computed(() => ({
		overdue: this.plans().filter(
			(plan) => calculatePlanState(plan) === 'overdue',
		),
		due: this.plans().filter((plan) => calculatePlanState(plan) === 'due'),
		upcoming: this.plans().filter(
			(plan) => calculatePlanState(plan) === 'upcoming',
		),
	}));
	protected readonly activeCount = computed(
		() => this.plans().filter((plan) => plan.status === 'active').length,
	);
	protected readonly hasActiveCars = computed(() =>
		this.garage().some((car) => !car.archivedAt),
	);
	protected readonly visibleServiceRecords = computed(() =>
		this.serviceRecords().filter((record) =>
			this.historyFilter() === 'deleted'
				? Boolean(record.deletedAt)
				: !record.deletedAt,
		),
	);
	protected readonly totalServiceCost = computed(() =>
		this.visibleServiceRecords().reduce(
			(total, record) => total + (record.cost ?? 0),
			0,
		),
	);
	protected readonly serviceTotals = computed(() => {
		const totals = new Map<string, number>();
		for (const record of this.visibleServiceRecords()) {
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
		let handledPlanOperationId = 0;
		effect(() => {
			const outcome = this.planStore.outcome();
			if (
				outcome.status === 'idle' ||
				outcome.status === 'pending' ||
				outcome.operationId === handledPlanOperationId
			)
				return;
			handledPlanOperationId = outcome.operationId;
			if (outcome.status === 'failed') {
				this.handleMutationFailure(outcome.command, outcome.error);
				return;
			}
			if (outcome.command.kind === 'save-plan') {
				this.returnFocusSelector = '#maintenance-title';
				this.cancelEdit();
			}
		});
		let handledServiceOperationId = 0;
		effect(() => {
			const outcome = this.serviceStore.outcome();
			if (
				outcome.status === 'idle' ||
				outcome.status === 'pending' ||
				outcome.operationId === handledServiceOperationId
			)
				return;
			handledServiceOperationId = outcome.operationId;
			if (outcome.status === 'failed') {
				this.handleMutationFailure(outcome.command, outcome.error);
				return;
			}
			if (outcome.command.kind === 'save-service') {
				this.returnFocusSelector = '#maintenance-title';
				this.cancelServiceEdit();
			}
		});
	}

	protected load(): void {
		this.mutationError.set('');
		this.planStore.retry();
		this.serviceStore.retry();
	}

	protected openCreate(): void {
		if (!this.hasActiveCars()) return;
		this.returnFocusSelector = '[data-maintenance-launcher="new-plan"]';
		const firstCar = this.garage().find((car) => !car.archivedAt);
		this.planFields().reset({
			...emptyForm(),
			carId: firstCar?.id ?? '',
			baselineAt: this.localDateTime(new Date()),
		});
		this.editingId.set(null);
		this.formError.set('');
		this.loadComponents(this.form().carId);
		this.editing.set(true);
		this.focusAfterRender('#maintenance-form-title');
	}

	protected openEdit(plan: MaintenancePlan): void {
		if (this.isReadOnly(plan)) return;
		this.returnFocusSelector = `[data-maintenance-launcher="plan:${plan.id}"]`;
		this.planFields().reset({
			...emptyForm(),
			carId: plan.carId,
			componentId: plan.componentId ?? '',
			name: plan.name,
			calendarValue:
				plan.intervalUnit === 'none'
					? ''
					: plan.intervalValue
						? String(plan.intervalValue)
						: plan.intervalDays
							? String(plan.intervalDays)
							: '',
			calendarUnit:
				plan.intervalUnit === 'weeks' || plan.intervalUnit === 'months'
					? plan.intervalUnit
					: 'days',
			sessionInterval: plan.intervalSessions
				? String(plan.intervalSessions)
				: '',
			baselineAt: plan.baselineAt
				? this.localDateTime(new Date(plan.baselineAt))
				: '',
			baselineSessions: String(plan.baselineSessionCount ?? 0),
		});
		this.editingId.set(plan.id);
		this.formError.set('');
		this.loadComponents(plan.carId);
		this.editing.set(true);
		this.focusAfterRender('#maintenance-form-title');
	}

	protected cancelEdit(): void {
		this.editing.set(false);
		this.editingId.set(null);
		this.formError.set('');
		this.planFields().reset();
		this.restoreLauncherFocusAfterRender();
	}
	protected openServiceCreate(): void {
		this.returnFocusSelector = '[data-maintenance-launcher="service"]';
		const firstCar = this.garage().find((car) => !car.archivedAt);
		this.serviceFields().reset({
			...emptyServiceForm(),
			carId: firstCar?.id ?? '',
			performedAt: this.localDateTime(new Date()),
		});
		this.serviceEditingId.set(null);
		this.servicePlanId.set(null);
		this.serviceError.set('');
		this.loadServiceComponents(firstCar?.id ?? '');
		this.serviceEditing.set(true);
		this.focusAfterRender('#service-form-title');
	}

	protected openServiceEdit(record: ServiceRecord): void {
		if (this.isRecordReadOnly(record)) return;
		this.returnFocusSelector = `[data-maintenance-launcher="record:${record.id}"]`;
		this.serviceFields().reset({
			carId: record.carId,
			componentId: record.componentId ?? '',
			performedAt: this.localDateTime(new Date(record.performedAt)),
			description: record.description,
			notes: record.notes ?? '',
			cost: record.cost == null ? '' : String(record.cost),
			currency: record.currency ?? 'USD',
		});
		this.serviceEditingId.set(record.id);
		this.servicePlanId.set(record.planId ?? null);
		this.serviceError.set('');
		this.loadServiceComponents(record.carId);
		this.serviceEditing.set(true);
		this.focusAfterRender('#service-form-title');
	}

	protected openCompletion(plan: MaintenancePlan): void {
		if (this.isReadOnly(plan)) return;
		this.returnFocusSelector = `[data-maintenance-launcher="complete:${plan.id}"]`;
		this.serviceFields().reset({
			...emptyServiceForm(),
			carId: plan.carId,
			componentId: plan.componentId ?? '',
			performedAt: this.localDateTime(new Date()),
			description: `Completed ${plan.name}`,
		});
		this.serviceEditingId.set(null);
		this.servicePlanId.set(plan.id);
		this.serviceError.set('');
		this.loadServiceComponents(plan.carId);
		this.serviceEditing.set(true);
		this.focusAfterRender('#service-form-title');
	}

	protected cancelServiceEdit(): void {
		this.serviceEditing.set(false);
		this.serviceEditingId.set(null);
		this.servicePlanId.set(null);
		this.serviceError.set('');
		this.serviceFields().reset();
		this.restoreLauncherFocusAfterRender();
	}
	protected updateService(field: keyof ServiceForm, value: string): void {
		this.serviceForm.update((current) => ({ ...current, [field]: value }));
		if (field === 'carId') this.loadServiceComponents(value);
	}
	protected changeServiceCar(event: Event): void {
		const carId = this.selectedValue(event);
		if (carId !== null) this.updateService('carId', carId);
	}
	protected setHistoryFilter(value: 'active' | 'deleted'): void {
		this.historyFilter.set(value);
	}

	protected saveService(event?: Event): void {
		event?.preventDefault();
		this.serviceFields().markAsTouched();
		const form = this.serviceForm();
		const cost = form.cost.trim() ? Number(form.cost) : null;
		if (this.serviceFields().invalid()) {
			this.serviceError.set(
				this.serviceFields().errorSummary()[0]?.message ??
					'Review the service record fields.',
			);
			if (this.serviceFields.carId().invalid())
				this.serviceFields.carId().focusBoundControl();
			else if (this.serviceFields.performedAt().invalid())
				this.serviceFields.performedAt().focusBoundControl();
			else if (this.serviceFields.description().invalid())
				this.serviceFields.description().focusBoundControl();
			else if (this.serviceFields.cost().invalid())
				this.serviceFields.cost().focusBoundControl();
			else if (this.serviceFields.currency().invalid())
				this.serviceFields.currency().focusBoundControl();
			else this.serviceFields.notes().focusBoundControl();
			return;
		}
		if (cost !== null && (!Number.isFinite(cost) || cost < 0)) {
			this.serviceError.set('Cost must be zero or greater.');
			return;
		}
		if (this.serviceAction()) return;
		const service = {
			performedAt: this.toIso(form.performedAt),
			description: form.description.trim(),
			...(form.notes?.trim() ? { notes: form.notes.trim() } : {}),
			componentId: form.componentId || undefined,
			...(cost === null
				? {}
				: { cost, currency: form.currency.trim().toUpperCase() || 'USD' }),
		};
		const recordId = this.serviceEditingId();
		const planId = this.servicePlanId();
		this.serviceError.set('');
		this.serviceStore.mutate({
			kind: 'save-service',
			mode: recordId ? 'edit' : planId ? 'complete' : 'create',
			carId: form.carId,
			id: recordId ?? planId,
			service,
		});
	}
	protected update(field: keyof MaintenanceForm, value: string): void {
		this.form.update((current) => ({ ...current, [field]: value }));
		if (field === 'carId') this.loadComponents(value);
	}
	protected changePlanCar(event: Event): void {
		const carId = this.selectedValue(event);
		if (carId !== null) this.update('carId', carId);
	}
	protected setFilter(value: 'all' | PlanState): void {
		this.selectedFilter.set(value);
	}

	protected save(event?: Event): void {
		event?.preventDefault();
		this.planFields().markAsTouched();
		const form = this.form();
		const calendar = form.calendarValue.trim()
			? Number(form.calendarValue)
			: null;
		const sessions = form.sessionInterval.trim()
			? Number(form.sessionInterval)
			: null;
		if (this.planFields().invalid()) {
			this.formError.set(
				this.planFields().errorSummary()[0]?.message ??
					'Review the maintenance plan fields.',
			);
			if (this.planFields.carId().invalid())
				this.planFields.carId().focusBoundControl();
			else if (this.planFields.name().invalid())
				this.planFields.name().focusBoundControl();
			else if (this.planFields.calendarValue().invalid())
				this.planFields.calendarValue().focusBoundControl();
			else if (this.planFields.sessionInterval().invalid())
				this.planFields.sessionInterval().focusBoundControl();
			else this.planFields.baselineSessions().focusBoundControl();
			return;
		}
		if (
			(calendar !== null && (!Number.isInteger(calendar) || calendar < 1)) ||
			(sessions !== null && (!Number.isInteger(sessions) || sessions < 1))
		) {
			this.formError.set('Intervals must be whole numbers greater than zero.');
			return;
		}
		if (calendar === null && sessions === null) {
			this.formError.set(
				'Add a calendar interval, a drive-session threshold, or both.',
			);
			return;
		}
		if (this.action()) return;
		this.mutationError.set('');
		const plan: MaintenancePlanDraft = {
			carId: form.carId,
			componentId: form.componentId || undefined,
			name: form.name.trim(),
			intervalUnit: calendar === null ? 'none' : form.calendarUnit,
			intervalValue: calendar === null ? 1 : calendar,
			...(calendar !== null && form.calendarUnit === 'days'
				? { intervalDays: calendar }
				: {}),
			intervalSessions: sessions === null ? undefined : sessions,
			baselineAt: form.baselineAt ? this.toIso(form.baselineAt) : undefined,
			baselineSessionCount: Number(form.baselineSessions) || 0,
		};
		const id = this.editingId();
		this.formError.set('');
		this.planStore.mutate({
			kind: 'save-plan',
			mode: id ? 'edit' : 'create',
			id,
			plan,
		});
	}

	protected transition(
		plan: MaintenancePlan,
		action: 'pause' | 'resume' | 'archive',
	): void {
		if (this.isReadOnly(plan)) return;
		this.mutationError.set('');
		this.planStore.mutate({
			kind: 'transition-plan',
			planId: plan.id,
			action,
		});
	}

	protected deleteService(record: ServiceRecord): void {
		if (this.isRecordReadOnly(record) || this.serviceAction()) return;
		this.serviceStore.mutate({
			kind: 'change-service',
			recordId: record.id,
			action: 'archive',
		});
	}

	protected restoreService(record: ServiceRecord): void {
		this.serviceStore.mutate({
			kind: 'change-service',
			recordId: record.id,
			action: 'restore',
		});
	}

	protected undoActivity(item: MaintenanceActivity): void {
		this.mutationError.set('');
		this.serviceStore.mutate({ kind: 'undo-activity', recordId: item.id });
	}

	private handleMutationFailure(
		command: MaintenancePlanCommand | ServiceRecordCommand,
		error: MaintenanceGatewayFailure,
	): void {
		const status = error.kind === 'http' ? error.status : undefined;
		if (command.kind === 'save-plan') {
			this.formError.set(
				status === 401
					? 'Your garage session has expired. Sign in again to continue.'
					: status === 409
						? 'This car is archived. Restore it before changing maintenance.'
						: 'The maintenance plan could not be saved.',
			);
			return;
		}
		if (command.kind === 'transition-plan') {
			this.mutationError.set('That maintenance update could not be saved.');
			return;
		}
		if (command.kind === 'save-service') {
			this.serviceError.set(
				status === 409
					? 'This car is archived. Restore it before recording service.'
					: status === 401
						? 'Your garage session has expired. Sign in again to continue.'
						: 'The service record could not be saved.',
			);
			return;
		}
		if (command.kind === 'change-service') {
			this.serviceError.set(
				command.action === 'archive'
					? 'That service record could not be archived.'
					: 'That service record could not be restored.',
			);
			return;
		}
		this.mutationError.set('That completion could not be undone.');
	}

	protected carName(carId: string): string {
		return this.garage().find((car) => car.id === carId)?.name ?? 'Unknown car';
	}
	protected componentName(componentId: string | null | undefined): string {
		return componentId
			? (this.components().find((component) => component.id === componentId)
					?.name ?? 'Installed component')
			: 'Car-level plan';
	}
	protected planState(plan: MaintenancePlan): PlanState {
		return calculatePlanState(plan);
	}
	protected isReadOnly(plan: MaintenancePlan): boolean {
		return (
			Boolean(this.garage().find((car) => car.id === plan.carId)?.archivedAt) ||
			plan.status === 'archived'
		);
	}
	protected isRecordReadOnly(record: ServiceRecord): boolean {
		return (
			Boolean(
				this.garage().find((car) => car.id === record.carId)?.archivedAt,
			) || Boolean(record.deletedAt)
		);
	}
	protected recordCarName(record: ServiceRecord): string {
		return this.carName(record.carId);
	}
	protected recordComponentName(record: ServiceRecord): string {
		return record.componentId
			? this.componentName(record.componentId)
			: 'Garage service';
	}
	protected recordCost(record: ServiceRecord): string {
		return record.cost == null
			? 'No cost logged'
			: `${record.currency ?? 'USD'} ${record.cost.toFixed(2)}`;
	}
	protected stateLabel(value: PlanState): string {
		return value === 'upcoming'
			? 'Upcoming'
			: value[0].toUpperCase() + value.slice(1);
	}

	protected filterLabel(value: 'all' | PlanState): string {
		return value === 'all' ? 'Everything' : this.stateLabel(value);
	}
	protected dueText(plan: MaintenancePlan): string {
		const state = this.planState(plan);
		const dueAt = plan.dateDueAt ?? plan.nextDueAt;
		return state === 'overdue'
			? 'Needs attention'
			: state === 'due'
				? 'Due now'
				: state === 'paused'
					? 'Paused'
					: state === 'archived'
						? 'Archived'
						: dueAt
							? `Due ${new Date(dueAt).toLocaleDateString('en-US', { timeZone: this.timezone(), month: 'short', day: 'numeric' })}`
							: 'Baseline set';
	}
	protected localDateTime(date: Date): string {
		const parts = new Intl.DateTimeFormat('en-CA', {
			timeZone: this.timezone(),
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
		}).formatToParts(date);
		const get = (type: string) =>
			parts.find((part) => part.type === type)?.value ?? '';
		return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
	}
	private toIso(value: string): string {
		const [date, time] = value.split('T');
		if (!date || !time) return '';
		const [year, month, day] = date.split('-').map(Number);
		const [hour, minute] = time.split(':').map(Number);
		const asUtc = Date.UTC(year, month - 1, day, hour, minute);
		const parts = new Intl.DateTimeFormat('en-US', {
			timeZone: this.timezone(),
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
		}).formatToParts(new Date(asUtc));
		const get = (type: string) =>
			Number(parts.find((part) => part.type === type)?.value);
		const offset =
			Date.UTC(
				get('year'),
				get('month') - 1,
				get('day'),
				get('hour'),
				get('minute'),
			) - asUtc;
		return new Date(asUtc - offset).toISOString();
	}
	protected loadComponents(carId: string): void {
		this.planStore.loadComponents(carId);
	}

	private loadServiceComponents(carId: string): void {
		this.serviceStore.loadComponents(carId);
	}

	private selectedValue(event: Event): string | null {
		return event.target instanceof HTMLSelectElement
			? event.target.value
			: null;
	}

	private focusAfterRender(selector: string): void {
		afterNextRender(
			() =>
				this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(),
			{ injector: this.injector },
		);
	}

	private restoreLauncherFocusAfterRender(): void {
		this.focusAfterRender(this.returnFocusSelector);
	}
}
