import { DatePipe } from '@angular/common';
import {
	Component,
	computed,
	effect,
	inject,
	model,
	output,
	signal,
} from '@angular/core';
import {
	LucideArchive,
	LucideArchiveRestore,
	LucidePencil,
	LucideRotateCcw,
	LucideTriangleAlert,
} from '@lucide/angular';
import type { MaintenanceActivity, ServiceRecord } from './maintenance.models';
import { serviceRecordIsReadOnly } from './maintenance-read-only.rules';
import { ServiceRecordStore } from './service-record-store';

@Component({
	selector: 'app-service-records',
	imports: [
		DatePipe,
		LucideArchive,
		LucideArchiveRestore,
		LucidePencil,
		LucideRotateCcw,
		LucideTriangleAlert,
	],
	templateUrl: './service-records.html',
	host: { class: 'contents' },
})
export class ServiceRecords {
	private readonly store = inject(ServiceRecordStore);
	private readonly handledOperationId = signal(
		this.store.outcome().operationId ?? 0,
	);

	readonly filter = model<'active' | 'deleted'>('active');
	readonly editRequested = output<ServiceRecord>();

	protected readonly garage = computed(() => this.store.cars());
	protected readonly records = computed(() => this.store.records());
	protected readonly activity = this.store.activity;
	protected readonly timezone = this.store.timezone;
	protected readonly components = this.store.components;
	protected readonly action = this.store.action;
	protected readonly error = signal('');
	protected readonly visibleRecords = computed(() =>
		this.records().filter((record) =>
			this.filter() === 'deleted'
				? Boolean(record.deletedAt)
				: !record.deletedAt,
		),
	);

	constructor() {
		effect(() => {
			const outcome = this.store.outcome();
			if (
				outcome.status === 'idle' ||
				outcome.status === 'pending' ||
				outcome.operationId === this.handledOperationId()
			)
				return;
			this.handledOperationId.set(outcome.operationId);
			if (outcome.status !== 'failed') return;
			if (outcome.failure === 'archive-failed')
				this.error.set('That service record could not be archived.');
			else if (outcome.failure === 'restore-failed')
				this.error.set('That service record could not be restored.');
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
		this.store.mutate({ kind: 'undo-activity', recordId: item.id });
	}

	protected isReadOnly(record: ServiceRecord): boolean {
		return serviceRecordIsReadOnly(record, this.garage());
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
}
