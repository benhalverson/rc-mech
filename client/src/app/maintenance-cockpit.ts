import { CommonModule, DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import {
	Component,
	computed,
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
import { ConsumableMaintenance } from './consumable-maintenance';
import type {
	MaintenanceActivity,
	MaintenanceComponent,
	MaintenancePlan,
	PlanState,
	ServiceRecord,
} from './maintenance/maintenance.models';
import { MaintenanceLookups } from './maintenance/maintenance-lookups';
import { MaintenanceStore } from './maintenance/maintenance-store';

export type {
	MaintenancePlan,
	ServiceRecord,
} from './maintenance/maintenance.models';

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

type PlanResponse = { maintenancePlan: MaintenancePlan };

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
	imports: [CommonModule, ConsumableMaintenance, DatePipe, FormField],
	templateUrl: './maintenance-cockpit.html',
	styleUrl: './maintenance-cockpit.css',
})
export class MaintenanceCockpit {
	private readonly http = inject(HttpClient);
	private readonly lookups = inject(MaintenanceLookups);
	private readonly store = inject(MaintenanceStore);
	protected readonly garage = linkedSignal(() => this.store.cars());
	protected readonly plans = linkedSignal(() => this.store.plans());
	protected readonly activity = this.store.activity;
	protected readonly serviceRecords = linkedSignal(() =>
		this.store.serviceRecords(),
	);
	protected readonly timezone = this.store.timezone;
	protected readonly components = signal<MaintenanceComponent[]>([]);
	protected readonly mutationError = signal('');
	protected readonly state = computed(() =>
		this.store.cockpitLoading()
			? 'loading'
			: this.store.cockpitError()
				? 'error'
				: 'ready',
	);
	protected readonly error = this.store.cockpitError;
	protected readonly editing = signal(false);
	protected readonly serviceEditing = signal(false);
	protected readonly serviceEditingId = signal<string | null>(null);
	protected readonly servicePlanId = signal<string | null>(null);
	protected readonly editingId = signal<string | null>(null);
	protected readonly action = signal<string | null>(null);
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
	protected readonly serviceAction = signal<string | null>(null);
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

	protected load(): void {
		this.mutationError.set('');
		this.store.retryCockpit();
	}

	protected openCreate(): void {
		if (!this.hasActiveCars()) return;
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
	}

	protected openEdit(plan: MaintenancePlan): void {
		if (this.isReadOnly(plan)) return;
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
	}

	protected cancelEdit(): void {
		this.editing.set(false);
		this.editingId.set(null);
		this.formError.set('');
		this.planFields().reset();
	}
	protected openServiceCreate(): void {
		const firstCar = this.garage().find((car) => !car.archivedAt);
		this.serviceFields().reset({
			...emptyServiceForm(),
			carId: firstCar?.id ?? '',
			performedAt: this.localDateTime(new Date()),
		});
		this.serviceEditingId.set(null);
		this.servicePlanId.set(null);
		this.serviceError.set('');
		this.loadComponents(firstCar?.id ?? '');
		this.serviceEditing.set(true);
	}

	protected openServiceEdit(record: ServiceRecord): void {
		if (this.isRecordReadOnly(record)) return;
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
		this.loadComponents(record.carId);
		this.serviceEditing.set(true);
	}

	protected openCompletion(plan: MaintenancePlan): void {
		if (this.isReadOnly(plan)) return;
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
		this.loadComponents(plan.carId);
		this.serviceEditing.set(true);
	}

	protected cancelServiceEdit(): void {
		this.serviceEditing.set(false);
		this.serviceEditingId.set(null);
		this.servicePlanId.set(null);
		this.serviceError.set('');
		this.serviceFields().reset();
	}
	protected updateService(field: keyof ServiceForm, value: string): void {
		this.serviceForm.update((current) => ({ ...current, [field]: value }));
		if (field === 'carId') this.loadComponents(value);
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
		const payload = {
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
		this.serviceAction.set(recordId ? 'edit' : planId ? 'complete' : 'create');
		this.serviceError.set('');
		const request = recordId
			? this.http.patch<{ serviceRecord: ServiceRecord }>(
					`/api/v1/service-records/${recordId}`,
					payload,
					{ withCredentials: true },
				)
			: planId
				? this.http.post<{
						serviceRecord: ServiceRecord;
						maintenancePlan: MaintenancePlan;
					}>(`/api/v1/maintenance-plans/${planId}/complete`, payload, {
						withCredentials: true,
					})
				: this.http.post<{ serviceRecord: ServiceRecord }>(
						`/api/v1/cars/${form.carId}/service-records`,
						payload,
						{ withCredentials: true },
					);
		request.subscribe({
			next: () => {
				this.store.refreshServiceRecords();
				this.store.refreshPlans();
				this.cancelServiceEdit();
				this.serviceAction.set(null);
			},
			error: (error: { status?: number }) => {
				this.serviceAction.set(null);
				this.serviceError.set(
					error.status === 409
						? 'This car is archived. Restore it before recording service.'
						: error.status === 401
							? 'Your garage session has expired. Sign in again to continue.'
							: 'The service record could not be saved.',
				);
			},
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
		const payload = {
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
		this.action.set(id ? 'edit' : 'create');
		this.formError.set('');
		const request = id
			? this.http.patch<PlanResponse>(
					`/api/v1/maintenance-plans/${id}`,
					payload,
					{ withCredentials: true },
				)
			: this.http.post<PlanResponse>('/api/v1/maintenance-plans', payload, {
					withCredentials: true,
				});
		request.subscribe({
			next: () => {
				this.store.refreshPlans();
				this.cancelEdit();
				this.action.set(null);
			},
			error: (error: { status?: number }) => {
				this.action.set(null);
				this.formError.set(
					error.status === 401
						? 'Your garage session has expired. Sign in again to continue.'
						: error.status === 409
							? 'This car is archived. Restore it before changing maintenance.'
							: 'The maintenance plan could not be saved.',
				);
			},
		});
	}

	protected transition(
		plan: MaintenancePlan,
		action: 'pause' | 'resume' | 'archive',
	): void {
		if (this.isReadOnly(plan)) return;
		this.mutationError.set('');
		this.action.set(`${action}:${plan.id}`);
		const request = this.http.post<PlanResponse>(
			`/api/v1/maintenance-plans/${plan.id}/${action}`,
			{},
			{ withCredentials: true },
		);
		request.subscribe({
			next: () => {
				this.store.refreshPlans();
				this.action.set(null);
			},
			error: () => {
				this.action.set(null);
				this.mutationError.set('That maintenance update could not be saved.');
			},
		});
	}

	protected deleteService(record: ServiceRecord): void {
		if (this.isRecordReadOnly(record) || this.serviceAction()) return;
		this.serviceAction.set(`delete:${record.id}`);
		this.http
			.delete<{
				serviceRecord: ServiceRecord;
				maintenancePlan?: MaintenancePlan;
			}>(`/api/v1/service-records/${record.id}`, { withCredentials: true })
			.subscribe({
				next: () => {
					this.store.refreshServiceRecords();
					this.store.refreshPlans();
					this.serviceAction.set(null);
				},
				error: () => {
					this.serviceAction.set(null);
					this.serviceError.set('That service record could not be archived.');
				},
			});
	}

	protected restoreService(record: ServiceRecord): void {
		this.serviceAction.set(`restore:${record.id}`);
		this.http
			.post<{
				serviceRecord: ServiceRecord;
				maintenancePlan?: MaintenancePlan;
			}>(
				`/api/v1/service-records/${record.id}/restore`,
				{},
				{ withCredentials: true },
			)
			.subscribe({
				next: () => {
					this.store.refreshServiceRecords();
					this.store.refreshPlans();
					this.serviceAction.set(null);
				},
				error: () => {
					this.serviceAction.set(null);
					this.serviceError.set('That service record could not be restored.');
				},
			});
	}

	protected undoActivity(item: MaintenanceActivity): void {
		this.mutationError.set('');
		this.http
			.delete(`/api/v1/service-records/${item.id}`, { withCredentials: true })
			.subscribe({
				next: () => {
					this.store.refreshServiceRecords();
					this.store.refreshPlans();
				},
				error: () =>
					this.mutationError.set('That completion could not be undone.'),
			});
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
		if (!carId) {
			this.components.set([]);
			return;
		}
		this.lookups.components(carId).subscribe({
			next: (components) => this.components.set(components),
			error: () => this.components.set([]),
		});
	}

	private selectedValue(event: Event): string | null {
		return event.target instanceof HTMLSelectElement
			? event.target.value
			: null;
	}
}
