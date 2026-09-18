import { DecimalPipe } from '@angular/common';
import {
	Component,
	type ElementRef,
	inject,
	input,
	type OnChanges,
	signal,
	viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { CornerClip } from './corner-clip';
import { exclusionReasonLabel } from './corner-review.models';
import { CornerReviewStore } from './corner-review-store';

@Component({
	selector: 'app-corner-review',
	imports: [DecimalPipe, RouterLink, CornerClip],
	templateUrl: './corner-review.html',
})
export class CornerReview implements OnChanges {
	readonly analysisId = input('');
	protected readonly store = inject(CornerReviewStore);
	protected readonly exclusionLabel = exclusionReasonLabel;
	protected readonly confirmingDeletion = signal(false);
	private readonly deleteButton = viewChild.required<
		ElementRef<HTMLButtonElement>
	>('deleteAnalysisButton');
	protected keepAnalysis(): void {
		this.confirmingDeletion.set(false);
		this.deleteButton().nativeElement.focus();
	}
	ngOnChanges(): void {
		this.confirmingDeletion.set(false);
		this.store.selectAnalysis({ analysisId: this.analysisId() });
	}
}
