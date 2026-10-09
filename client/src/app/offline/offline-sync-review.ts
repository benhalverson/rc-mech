import { TitleCasePipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import {
	deviceReviewValue,
	remoteReviewValue,
	reviewFeedback,
	reviewFields,
} from './offline-sync-review-presenter';
import { OfflineSyncReviewStore } from './offline-sync-review-store';

@Component({
	selector: 'app-offline-sync-review',
	imports: [TitleCasePipe],
	templateUrl: './offline-sync-review.html',
})
export class OfflineSyncReview {
	protected readonly fields = reviewFields;
	protected readonly device = deviceReviewValue;
	protected readonly remote = remoteReviewValue;
	protected readonly feedback = reviewFeedback;
	protected readonly store = inject(OfflineSyncReviewStore);
}
