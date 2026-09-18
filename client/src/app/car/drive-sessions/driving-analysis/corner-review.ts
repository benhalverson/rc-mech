import { DecimalPipe } from '@angular/common';
import { Component, inject, input, type OnChanges } from '@angular/core';
import { RouterLink } from '@angular/router';
import { exclusionReasonLabel } from './corner-review.models';
import { CornerReviewStore } from './corner-review-store';

@Component({
	selector: 'app-corner-review',
	imports: [DecimalPipe, RouterLink],
	templateUrl: './corner-review.html',
})
export class CornerReview implements OnChanges {
	readonly analysisId = input('');
	protected readonly store = inject(CornerReviewStore);
	protected readonly exclusionLabel = exclusionReasonLabel;
	ngOnChanges(): void {
		this.store.selectAnalysis({ analysisId: this.analysisId() });
	}
}
