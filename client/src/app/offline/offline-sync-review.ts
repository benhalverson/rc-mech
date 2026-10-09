import { TitleCasePipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import {
	deviceReviewValue,
	remoteReviewValue,
	reviewFeedback,
	reviewFields,
} from './offline-sync-review-presenter';
import { OfflineSyncReviewStore } from './offline-sync-review-store';

/**
 * Renders device and saved versions with explicit retry/discard actions. Keeps
 * details/focus presentation local and sends the exact displayed review to the
 * review coordinator; it does not reconstruct concurrency evidence in the UI.
 */
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
