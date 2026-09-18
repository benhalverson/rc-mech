import { DecimalPipe } from '@angular/common';
import {
	Component,
	inject,
	input,
	type OnChanges,
	signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { CornerClip } from './corner-clip';
import { exclusionReasonLabel } from './corner-review.models';
import { CornerReviewStore } from './corner-review-store';
import { SubjectReidentification } from './subject-reidentification';

@Component({
	selector: 'app-corner-review',
	imports: [DecimalPipe, RouterLink, CornerClip, SubjectReidentification],
	templateUrl: './corner-review.html',
})
export class CornerReview implements OnChanges {
	readonly analysisId = input('');
	protected readonly store = inject(CornerReviewStore);
	protected readonly exclusionLabel = exclusionReasonLabel;
	protected readonly confirmingDeletion = signal(false);
	ngOnChanges(): void {
		this.store.selectAnalysis({ analysisId: this.analysisId() });
	}
}
