import { CommonModule, DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import {
	ChangeDetectionStrategy,
	Component,
	Input,
	computed,
	inject,
	signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';

export type MaintenanceCar = {
	id: string;
	name: string;
	archivedAt?: string | null;
};
export type MaintenanceComponent = {
	id: string;
	carId: string;
	slot: string;
	name: string;
	removedAt?: string | null;
};
export type MaintenancePlan = {
	id: string;
	carId: string;
	componentId: string | null;
	name: string;
	intervalDays?: number | null;
	intervalUnit?: 'none' | 'days' | 'weeks' | 'months' | null;
	intervalValue?: number | null;
	intervalSessions?: number | null;
	baselineAt?: string | null;
	baselineSessionCount?: number | null;
	status: 'active' | 'paused' | 'archived' | string;
	pausedAt?: string | null;
	nextDueAt?: string | null;
	dateDueAt?: string | null;
	nextDueSessionCount?: number | null;
	completedAt?: string | null;
	updatedAt?: string | null;
	dueStatus?: PlanState;
};

export type MaintenanceActivity = {
	id: string;
	planId?: string;
	action: string;
	occurredAt: string;
	note?: string | null;
};
export type ServiceRecord = {
	id: string;
	carId: string;
	componentId?: string | null;
	planId?: string | null;
	performedAt: string;
	description: string;
	notes?: string | null;
	cost?: number | null;
	currency?: string | null;
	deletedAt?: string | null;
};
export type PlanState = 'upcoming' | 'due' | 'overdue' | 'paused' | 'archived';

export type MaintenanceForm = {
	carId: string;
	componentId: string;
	name: string;
	calendarValue: string;
	calendarUnit: 'days' | 'weeks' | 'months';
	runInterval: string;
	baselineAt: string;
	baselineRuns: string;
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

type PlansResponse = {
	maintenancePlans?: MaintenancePlan[];
	plans?: MaintenancePlan[];
	activity?: MaintenanceActivity[];
};
type ComponentsResponse = { components: MaintenanceComponent[] };
type PlanResponse = { maintenancePlan: MaintenancePlan };
type ServiceRecordsResponse = { serviceRecords?: ServiceRecord[] };

const emptyForm = (): MaintenanceForm => ({
	carId: '',
	componentId: '',
	name: '',
	calendarValue: '',
	calendarUnit: 'weeks',
	runInterval: '',
	baselineAt: '',
	baselineRuns: '0',
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
	const runsDue = plan.intervalSessions
		? sessionCount >= (plan.baselineSessionCount ?? 0) + plan.intervalSessions
		: false;
	if (calendarDue || runsDue) {
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
	standalone: true,
	imports: [CommonModule, DatePipe, FormsModule],
	templateUrl: './maintenance-cockpit.html',
	styleUrl: './maintenance-cockpit.css',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MaintenanceCockpit {
	private readonly http = inject(HttpClient);
	@Input() set cars(value: MaintenanceCar[]) {
		const wasEmpty = this.garage().length === 0;
		this.garage.set(value);
		if (!value.length) return;
		if (!this.loaded() || (wasEmpty && value.length > 0)) this.load();
	}
	@Input() timezone = 'UTC';

	protected readonly garage = signal<MaintenanceCar[]>([]);
	protected readonly plans = signal<MaintenancePlan[]>([]);
	protected readonly activity = signal<MaintenanceActivity[]>([]);
	protected readonly serviceRecords = signal<ServiceRecord[]>([]);
	protected readonly components = signal<MaintenanceComponent[]>([]);
	protected readonly state = signal<
		'idle' | 'loading' | 'ready' | 'unavailable' | 'error'
	>('idle');
	protected readonly error = signal('');
	protected readonly loaded = signal(false);
	protected readonly editing = signal(false);
	protected readonly serviceEditing = signal(false);
	protected readonly serviceEditingId = signal<string | null>(null);
	protected readonly servicePlanId = signal<string | null>(null);
	protected readonly editingId = signal<string | null>(null);
	protected readonly action = signal<string | null>(null);
	protected readonly formError = signal('');
	protected readonly form = signal<MaintenanceForm>(emptyForm());
	protected readonly serviceForm = signal<ServiceForm>(emptyServiceForm());
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
		if (!this.garage().length) {
			this.state.set('ready');
			this.loaded.set(true);
			return;
		}
		this.state.set('loading');
		this.error.set('');
		this.http
			.get<PlansResponse>('/api/v1/maintenance-plans', {
				withCredentials: true,
			})
			.subscribe({
				next: (response) => {
					this.plans.set(response.maintenancePlans ?? response.plans ?? []);
					this.activity.set(response.activity ?? []);
					const requests = this.garage().map((car) =>
						this.http.get<ServiceRecordsResponse>(
							`/api/v1/cars/${car.id}/service-records`,
							{ withCredentials: true, params: { history: 'true' } },
						),
					);
					if (!requests.length) {
						this.finishLoad([]);
						return;
					}
					forkJoin(requests).subscribe({
						next: (responses) =>
							this.finishLoad(
								responses.flatMap((item) => item.serviceRecords ?? []),
							),
						error: () => this.finishLoad([]),
					});
				},
				error: (error: { status?: number }) => {
					this.loaded.set(true);
					this.state.set(error.status === 404 ? 'unavailable' : 'error');
					this.error.set(
						error.status === 401
							? 'Your garage session has expired. Sign in again to continue.'
							: 'Maintenance plans could not be loaded.',
					);
				},
			});
	}

	private finishLoad(records: ServiceRecord[]): void {
		this.serviceRecords.set(records);
		this.activity.update((items) =>
			items.length
				? items
				: records
						.filter((record) => !record.deletedAt)
						.map((record) => ({
							id: record.id,
							planId: record.planId ?? undefined,
							action: record.planId ? 'Scheduled service' : 'Ad hoc service',
							occurredAt: record.performedAt,
							note: record.description,
						})),
		);
		this.state.set('ready');
		this.loaded.set(true);
	}

	protected openCreate(): void {
		const firstCar = this.garage().find((car) => !car.archivedAt);
		this.form.set({
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
		this.form.set({
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
			runInterval: plan.intervalSessions ? String(plan.intervalSessions) : '',
			baselineAt: plan.baselineAt
				? this.localDateTime(new Date(plan.baselineAt))
				: '',
			baselineRuns: String(plan.baselineSessionCount ?? 0),
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
	}
	protected openServiceCreate(): void {
		const firstCar = this.garage().find((car) => !car.archivedAt);
		this.serviceForm.set({
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
		this.serviceForm.set({
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
		this.serviceForm.set({
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
	}
	protected updateService(field: keyof ServiceForm, value: string): void {
		this.serviceForm.update((current) => ({ ...current, [field]: value }));
		if (field === 'carId') this.loadComponents(value);
	}
	protected setHistoryFilter(value: 'active' | 'deleted'): void {
		this.historyFilter.set(value);
	}

	protected saveService(): void {
		const form = this.serviceForm();
		const cost = form.cost.trim() ? Number(form.cost) : null;
		if (!form.carId || !form.description.trim() || !form.performedAt) {
			this.serviceError.set('Choose a car, date, and a short description.');
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
			next: (response) => {
				const record = response.serviceRecord;
				const updatedPlan = (response as { maintenancePlan?: MaintenancePlan })
					.maintenancePlan;
				this.serviceRecords.update((records) =>
					recordId
						? records.map((item) => (item.id === recordId ? record : item))
						: [record, ...records],
				);
				if (planId && updatedPlan)
					this.plans.update((plans) =>
						plans.map((item) => (item.id === planId ? updatedPlan : item)),
					);
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
	protected setFilter(value: 'all' | PlanState): void {
		this.selectedFilter.set(value);
	}

	protected save(): void {
		const form = this.form();
		const calendar = form.calendarValue.trim()
			? Number(form.calendarValue)
			: null;
		const runs = form.runInterval.trim() ? Number(form.runInterval) : null;
		if (!form.carId || !form.name.trim()) {
			this.formError.set('Choose a car and name the care rule.');
			return;
		}
		if (
			(calendar !== null && (!Number.isInteger(calendar) || calendar < 1)) ||
			(runs !== null && (!Number.isInteger(runs) || runs < 1))
		) {
			this.formError.set('Intervals must be whole numbers greater than zero.');
			return;
		}
		if (calendar === null && runs === null) {
			this.formError.set('Add a calendar interval, a run threshold, or both.');
			return;
		}
		if (this.action()) return;
		const payload = {
			carId: form.carId,
			componentId: form.componentId || undefined,
			name: form.name.trim(),
			intervalUnit: calendar === null ? 'none' : form.calendarUnit,
			intervalValue: calendar === null ? 1 : calendar,
			...(calendar !== null && form.calendarUnit === 'days'
				? { intervalDays: calendar }
				: {}),
			intervalSessions: runs === null ? undefined : runs,
			baselineAt: form.baselineAt ? this.toIso(form.baselineAt) : undefined,
			baselineSessionCount: Number(form.baselineRuns) || 0,
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
			next: ({ maintenancePlan }) => {
				this.plans.update((plans) =>
					id
						? plans.map((plan) => (plan.id === id ? maintenancePlan : plan))
						: [maintenancePlan, ...plans],
				);
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
		this.action.set(`${action}:${plan.id}`);
		const request = this.http.post<PlanResponse>(
			`/api/v1/maintenance-plans/${plan.id}/${action}`,
			{},
			{ withCredentials: true },
		);
		request.subscribe({
			next: ({ maintenancePlan }) => {
				this.plans.update((plans) =>
					plans.map((item) => (item.id === plan.id ? maintenancePlan : item)),
				);
				this.action.set(null);
			},
			error: () => {
				this.action.set(null);
				this.error.set('That maintenance update could not be saved.');
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
				next: (response) => {
					const deleted = response.serviceRecord;
					this.serviceRecords.update((records) =>
						records.map((item) => (item.id === record.id ? deleted : item)),
					);
					const maintenancePlan = response.maintenancePlan;
					if (maintenancePlan) {
						this.plans.update((plans) =>
							plans.map((item) =>
								item.id === maintenancePlan.id ? maintenancePlan : item,
							),
						);
					}
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
				next: ({ serviceRecord: restored, maintenancePlan }) => {
					this.serviceRecords.update((records) =>
						records.map((item) => (item.id === record.id ? restored : item)),
					);
					if (maintenancePlan)
						this.plans.update((plans) =>
							plans.map((item) =>
								item.id === maintenancePlan.id ? maintenancePlan : item,
							),
						);
					this.serviceAction.set(null);
				},
				error: () => {
					this.serviceAction.set(null);
					this.serviceError.set('That service record could not be restored.');
				},
			});
	}

	protected undoActivity(item: MaintenanceActivity): void {
		this.http
			.delete(`/api/v1/service-records/${item.id}`, { withCredentials: true })
			.subscribe({
				next: () => this.load(),
				error: () => this.error.set('That completion could not be undone.'),
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
							? `Due ${new Date(dueAt).toLocaleDateString('en-US', { timeZone: this.timezone, month: 'short', day: 'numeric' })}`
							: 'Baseline set';
	}
	protected localDateTime(date: Date): string {
		const parts = new Intl.DateTimeFormat('en-CA', {
			timeZone: this.timezone,
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
			timeZone: this.timezone,
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
	private loadComponents(carId: string): void {
		if (!carId) {
			this.components.set([]);
			return;
		}
		this.http
			.get<ComponentsResponse>(`/api/v1/cars/${carId}/components`, {
				withCredentials: true,
			})
			.subscribe({
				next: ({ components }) =>
					this.components.set(
						components.filter((component) => !component.removedAt),
					),
				error: () => this.components.set([]),
			});
	}
}
