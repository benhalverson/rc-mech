import { Component, computed, inject, signal } from '@angular/core';
import {
	LucidePlus,
	LucideRefreshCw,
	LucideTriangleAlert,
} from '@lucide/angular';
import { ConsumableMaintenance } from './consumables/consumable-maintenance';
import { MaintenancePlans } from './maintenance-plans';
import { MaintenancePlanStore } from './maintenance-plan-store';
import type { MaintenancePlan } from './maintenance.models';
import { ServiceRecords } from './service-records';
import { ServiceRecordStore } from './service-record-store';

export type { MaintenancePlan, ServiceRecord } from './maintenance.models';
export {
	calculatePlanState,
	calendarDays,
} from './maintenance-plan.rules';

@Component({
	selector: 'app-maintenance-cockpit',
	imports: [
		ConsumableMaintenance,
		LucidePlus,
		LucideRefreshCw,
		LucideTriangleAlert,
		MaintenancePlans,
		ServiceRecords,
	],
	templateUrl: './maintenance-cockpit.html',
	host: { class: 'block' },
})
export class MaintenanceCockpit {
	private readonly planStore = inject(MaintenancePlanStore);
	private readonly serviceStore = inject(ServiceRecordStore);

	protected readonly activeEditor = signal<'plan' | 'service' | null>(null);
	protected readonly completionPlan = signal<MaintenancePlan | null>(null);
	protected readonly createPlanRequested = signal(false);
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

	protected canCreatePlan(): boolean {
		return Boolean(this.planStore.plans().length);
	}

	protected openCreatePlan(): void {
		this.createPlanRequested.set(true);
	}

	protected planEditing(editing: boolean): void {
		this.activeEditor.set(editing ? 'plan' : null);
		if (editing) this.createPlanRequested.set(false);
	}

	protected serviceEditing(editing: boolean): void {
		this.activeEditor.set(editing ? 'service' : null);
	}

	protected complete(plan: MaintenancePlan): void {
		this.completionPlan.set(plan);
		this.activeEditor.set('service');
	}

	protected closeCompletion(): void {
		this.completionPlan.set(null);
	}

	protected load(): void {
		this.planStore.retry();
		this.serviceStore.retry();
	}
}
