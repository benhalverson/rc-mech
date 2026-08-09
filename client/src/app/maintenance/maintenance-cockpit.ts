import { Component, computed, inject, signal } from '@angular/core';
import {
	LucidePlus,
	LucideRefreshCw,
	LucideTriangleAlert,
	LucideWrench,
} from '@lucide/angular';
import { ConsumableMaintenance } from './consumables/consumable-maintenance';
import type {
	MaintenancePlan,
	PlanState,
	ServiceRecord,
} from './maintenance.models';
import { calculatePlanState } from './maintenance-plan.rules';
import {
	MaintenancePlanEditor,
	type MaintenancePlanEditorRequest,
} from './maintenance-plan-editor';
import { MaintenancePlanStore } from './maintenance-plan-store';
import { MaintenancePlans } from './maintenance-plans';
import {
	ServiceRecordEditor,
	type ServiceRecordEditorRequest,
} from './service-record-editor';
import { ServiceRecordStore } from './service-record-store';
import { ServiceRecordTotals } from './service-record-totals';
import { ServiceRecords } from './service-records';

type ActiveEditor =
	| {
			readonly workflow: 'plan';
			readonly request: MaintenancePlanEditorRequest;
	  }
	| {
			readonly workflow: 'service';
			readonly request: ServiceRecordEditorRequest;
	  };

@Component({
	selector: 'app-maintenance-cockpit',
	imports: [
		ConsumableMaintenance,
		LucidePlus,
		LucideRefreshCw,
		LucideTriangleAlert,
		LucideWrench,
		MaintenancePlanEditor,
		MaintenancePlans,
		ServiceRecordEditor,
		ServiceRecordTotals,
		ServiceRecords,
	],
	templateUrl: './maintenance-cockpit.html',
	host: { class: 'block' },
})
export class MaintenanceCockpit {
	private readonly planStore = inject(MaintenancePlanStore);
	private readonly serviceStore = inject(ServiceRecordStore);

	protected readonly activeEditor = signal<ActiveEditor | null>(null);
	protected readonly planFilter = signal<'all' | PlanState>('all');
	protected readonly serviceFilter = signal<'active' | 'deleted'>('active');
	protected readonly planRequest = computed(() => {
		const editor = this.activeEditor();
		return editor?.workflow === 'plan' ? editor.request : null;
	});
	protected readonly serviceRequest = computed(() => {
		const editor = this.activeEditor();
		return editor?.workflow === 'service' ? editor.request : null;
	});
	protected readonly hasActiveCars = computed(() =>
		this.planStore.cars().some((car) => !car.archivedAt),
	);
	protected readonly canCreatePlan = computed(() =>
		this.planStore
			.plans()
			.some(
				(plan) =>
					this.planFilter() === 'all' ||
					calculatePlanState(plan) === this.planFilter(),
			),
	);
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

	protected createPlan(): void {
		if (!this.hasActiveCars()) return;
		this.activeEditor.set({ workflow: 'plan', request: { kind: 'create' } });
	}

	protected editPlan(plan: MaintenancePlan): void {
		this.activeEditor.set({
			workflow: 'plan',
			request: { kind: 'edit', plan },
		});
	}

	protected completePlan(plan: MaintenancePlan): void {
		this.activeEditor.set({
			workflow: 'service',
			request: { kind: 'complete', plan },
		});
	}

	protected createService(): void {
		if (!this.hasActiveCars()) return;
		this.activeEditor.set({ workflow: 'service', request: { kind: 'create' } });
	}

	protected editService(record: ServiceRecord): void {
		this.activeEditor.set({
			workflow: 'service',
			request: { kind: 'edit', record },
		});
	}

	protected closeEditor(): void {
		this.activeEditor.set(null);
	}

	protected load(): void {
		this.planStore.retry();
		this.serviceStore.retry();
	}
}
