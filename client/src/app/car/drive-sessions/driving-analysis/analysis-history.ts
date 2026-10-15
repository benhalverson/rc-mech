import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, inject, input, type OnChanges } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AnalysisHistoryStore } from './analysis-history-store';
import type { DrivingAnalysis } from './driving-analysis.models';

@Component({
	selector: 'app-analysis-history',
	imports: [DatePipe, DecimalPipe, RouterLink],
	templateUrl: './analysis-history.html',
})
export class AnalysisHistory implements OnChanges {
	readonly carId = input('');
	readonly driveSessionId = input('');
	protected readonly store = inject(AnalysisHistoryStore);
	protected readonly statusLabels: Record<DrivingAnalysis['status'], string> = {
		queued: 'Queued',
		running: 'Processing',
		'awaiting-reidentification': 'Needs car correction',
		completed: 'Completed',
		failed: 'Failed',
		cancelled: 'Cancelled',
		deleting: 'Deleting',
		deleted: 'Deleted',
	};
	ngOnChanges(): void {
		this.store.select({
			carId: this.carId(),
			driveSessionId: this.driveSessionId(),
		});
	}
}
