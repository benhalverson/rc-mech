import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, input } from '@angular/core';
import { ServiceRecordStore } from './service-record-store';

@Component({
	selector: 'app-service-record-totals',
	imports: [DecimalPipe],
	templateUrl: './service-record-totals.html',
	host: { class: 'contents' },
})
export class ServiceRecordTotals {
	private readonly store = inject(ServiceRecordStore);

	readonly filter = input<'active' | 'deleted'>('active');

	protected readonly totals = computed(() => {
		const totals = new Map<string, number>();
		for (const record of this.store.records()) {
			const visible =
				this.filter() === 'deleted'
					? Boolean(record.deletedAt)
					: !record.deletedAt;
			if (visible && record.cost !== null && record.cost !== undefined) {
				const currency = record.currency ?? 'USD';
				totals.set(currency, (totals.get(currency) ?? 0) + record.cost);
			}
		}
		return [...totals.entries()].map(([currency, total]) => ({
			currency,
			total,
		}));
	});
}
