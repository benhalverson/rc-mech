import { Component, computed, inject } from '@angular/core';
import { LucideTriangleAlert } from '@lucide/angular';
import { MaintenancePlanStore } from './maintenance-plan-store';
import { ServiceRecordStore } from './service-record-store';

@Component({
	selector: 'app-maintenance-mutation-status',
	imports: [LucideTriangleAlert],
	templateUrl: './maintenance-mutation-status.html',
	host: { class: 'contents' },
})
export class MaintenanceMutationStatus {
	private readonly planStore = inject(MaintenancePlanStore);
	private readonly serviceStore = inject(ServiceRecordStore);

	protected readonly message = computed(() => {
		const planOutcome = this.planStore.outcome();
		if (
			planOutcome.status === 'failed' &&
			planOutcome.command.kind === 'transition-plan'
		)
			return 'That maintenance update could not be saved.';
		const serviceOutcome = this.serviceStore.outcome();
		return serviceOutcome.status === 'failed' &&
			serviceOutcome.command.kind === 'undo-activity'
			? 'That completion could not be undone.'
			: '';
	});
}
