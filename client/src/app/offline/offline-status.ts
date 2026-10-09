import { Component, inject } from '@angular/core';
import { OfflineSyncReview } from './offline-sync-review';
import { OfflineSyncStatusStore } from './offline-sync-status-store';
import { OfflineWorkspaceStore } from './offline-workspace-store';

@Component({
	selector: 'app-offline-status',
	imports: [OfflineSyncReview],
	templateUrl: './offline-status.html',
})
export class OfflineStatus {
	protected readonly sync = inject(OfflineSyncStatusStore);
	protected readonly store = inject(OfflineWorkspaceStore);
}
