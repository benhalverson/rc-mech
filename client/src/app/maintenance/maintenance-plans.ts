import { DOCUMENT } from '@angular/common';
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
	LucideCircleCheck,
	LucideClock,
	LucidePencil,
	LucidePlus,
	LucideSave,
	LucideTriangleAlert,
} from '@lucide/angular';
import {
	calculatePlanState,
	localDateTime,
	localDateTimeToIso,
} from './maintenance-plan.rules';
import {
	type MaintenancePlanCommand,
	MaintenancePlanStore,
} from './maintenance-plan-store';
import type {
	MaintenanceGatewayFailure,
	MaintenancePlan,
	MaintenancePlanDraft,
	PlanState,
} from './maintenance.models';

export type MaintenancePlanForm = {
	carId: string;
	componentId: string;
	name: string;
	calendarValue: string;
	calendarUnit: 'days' | 'weeks' | 'months';
	sessionInterval: string;
	baselineAt: string;
	baselineSessions: string;
};

const emptyForm = (): MaintenancePlanForm => ({
	carId: '',
	componentId: '',
	name: '',
	calendarValue: '',
	calendarUnit: 'weeks',
	sessionInterval: '',
	baselineAt: '',
	baselineSessions: '0',
});

@Component({
	selector: 'app-maintenance-plans',
	imports: [
		FormField,
		LucideArchive,
		LucideCircleCheck,
		LucideClock,
		LucidePencil,
		LucidePlus,
		LucideSave,
		LucideTriangleAlert,
	],
	templateUrl: './maintenance-plans.html',
	host: { class: 'contents' },
})
export class MaintenancePlans {
	private readonly store = inject(MaintenancePlanStore);
	private readonly document = inject(DOCUMENT);
	private readonly injector = inject(Injector);
	private returnFocusSelector = '[data-maintenance-launcher="new-plan"]';

	readonly siblingEditing = input(false);
	readonly createRequested = input(false);
	readonly editingChange = output<boolean>();
	readonly completePlan = output<MaintenancePlan>();

	protected readonly garage = linkedSignal(() => this.store.cars());
	protected readonly plans = linkedSignal(() => this.store.plans());
	protected readonly timezone = this.store.timezone;
	protected readonly components = this.store.components;
	protected readonly mutationError = signal('');
	protected readonly editing = signal(false);
	protected readonly editingId = signal<string | null>(null);
	protected readonly action = this.store.action;
	protected readonly formError = signal('');
	protected readonly form = signal<MaintenancePlanForm>(emptyForm());
	protected readonly fields = signalForm(this.form, (path) => {
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
	protected readonly selectedFilter = signal<'all' | PlanState>('all');
	protected readonly filterOptions: Array<'all' | PlanState> = [
		'all',
		'overdue',
		'due',
		'upcoming',
		'paused',
		'archived',
	];
	readonly visiblePlans = computed(() =>
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
			if (outcome.command.kind === 'save-plan') {
				this.returnFocusSelector = '#maintenance-title';
				this.cancelEdit();
			}
		});
		effect(() => {
			if (this.createRequested()) this.openCreate();
		});
	}

	openCreate(): void {
		const firstCar = this.garage().find((car) => !car.archivedAt);
		if (!firstCar) return;
		this.returnFocusSelector = '[data-maintenance-launcher="new-plan"]';
		this.fields().reset({
			...emptyForm(),
			carId: firstCar.id,
			baselineAt: localDateTime(new Date(), this.timezone()),
		});
		this.editingId.set(null);
		this.formError.set('');
		this.store.loadComponents(this.form().carId);
		this.editing.set(true);
		this.editingChange.emit(true);
		this.focusAfterRender('#maintenance-form-title');
	}

	protected openEdit(plan: MaintenancePlan): void {
		if (this.isReadOnly(plan)) return;
		this.returnFocusSelector = `[data-maintenance-launcher="plan:${plan.id}"]`;
		this.fields().reset({
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
				? localDateTime(new Date(plan.baselineAt), this.timezone())
				: '',
			baselineSessions: String(plan.baselineSessionCount ?? 0),
		});
		this.editingId.set(plan.id);
		this.formError.set('');
		this.store.loadComponents(plan.carId);
		this.editing.set(true);
		this.editingChange.emit(true);
		this.focusAfterRender('#maintenance-form-title');
	}

	protected cancelEdit(): void {
		this.editing.set(false);
		this.editingId.set(null);
		this.formError.set('');
		this.fields().reset();
		this.editingChange.emit(false);
		this.focusAfterRender(this.returnFocusSelector);
	}

	protected changeCar(event: Event): void {
		if (!(event.target instanceof HTMLSelectElement)) return;
		const carId = event.target.value;
		this.form.update((current) => ({ ...current, carId }));
		this.store.loadComponents(carId);
	}

	protected setFilter(value: 'all' | PlanState): void {
		this.selectedFilter.set(value);
	}

	protected save(event: Event): void {
		event.preventDefault();
		this.fields().markAsTouched();
		const form = this.form();
		const calendar = form.calendarValue.trim()
			? Number(form.calendarValue)
			: null;
		const sessions = form.sessionInterval.trim()
			? Number(form.sessionInterval)
			: null;
		if (this.fields().invalid()) {
			this.formError.set(
				this.fields().errorSummary()[0]?.message ??
					'Review the maintenance plan fields.',
			);
			if (this.fields.carId().invalid())
				this.fields.carId().focusBoundControl();
			else if (this.fields.name().invalid())
				this.fields.name().focusBoundControl();
			else if (this.fields.calendarValue().invalid())
				this.fields.calendarValue().focusBoundControl();
			else if (this.fields.sessionInterval().invalid())
				this.fields.sessionInterval().focusBoundControl();
			else this.fields.baselineSessions().focusBoundControl();
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
			baselineAt: form.baselineAt
				? localDateTimeToIso(form.baselineAt, this.timezone())
				: undefined,
			baselineSessionCount: Number(form.baselineSessions) || 0,
		};
		const id = this.editingId();
		this.formError.set('');
		this.store.mutate({
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
		this.store.mutate({ kind: 'transition-plan', planId: plan.id, action });
	}

	protected complete(plan: MaintenancePlan): void {
		if (!this.isReadOnly(plan)) this.completePlan.emit(plan);
	}

	private handleFailure(
		command: MaintenancePlanCommand,
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
		this.mutationError.set('That maintenance update could not be saved.');
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

	private focusAfterRender(selector: string): void {
		afterNextRender(
			() => this.document.querySelector<HTMLElement>(selector)?.focus(),
			{ injector: this.injector },
		);
	}
}
