import { Component, computed, inject, model, output } from '@angular/core';
import {
	LucideArchive,
	LucideCircleCheck,
	LucideClock,
	LucidePencil,
	LucidePlus,
} from '@lucide/angular';
import type { MaintenancePlan, PlanState } from './maintenance.models';
import {
	calculatePlanState,
	filterMaintenancePlans,
} from './maintenance-plan.rules';
import { MaintenancePlanStore } from './maintenance-plan-store';
import { maintenancePlanIsReadOnly } from './maintenance-read-only.rules';

@Component({
	selector: 'app-maintenance-plans',
	imports: [
		LucideArchive,
		LucideCircleCheck,
		LucideClock,
		LucidePencil,
		LucidePlus,
	],
	templateUrl: './maintenance-plans.html',
	host: { class: 'contents' },
})
export class MaintenancePlans {
	private readonly store = inject(MaintenancePlanStore);

	readonly filter = model<'all' | PlanState>('all');
	readonly createRequested = output<void>();
	readonly editRequested = output<MaintenancePlan>();
	readonly completionRequested = output<MaintenancePlan>();

	protected readonly garage = computed(() => this.store.cars());
	protected readonly plans = computed(() => this.store.plans());
	protected readonly timezone = this.store.timezone;
	protected readonly components = this.store.components;
	protected readonly action = this.store.action;
	protected readonly filterOptions: Array<'all' | PlanState> = [
		'all',
		'overdue',
		'due',
		'upcoming',
		'paused',
		'archived',
	];
	readonly visiblePlans = computed(() =>
		filterMaintenancePlans(this.plans(), this.filter()),
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

	protected transition(
		plan: MaintenancePlan,
		action: 'pause' | 'resume' | 'archive',
	): void {
		if (this.isReadOnly(plan) || this.action()) return;
		this.store.mutate({ kind: 'transition-plan', planId: plan.id, action });
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
		return maintenancePlanIsReadOnly(plan, this.garage());
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
}
