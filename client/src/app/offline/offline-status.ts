import { Component, inject } from '@angular/core';
import { OfflineSyncReview } from './offline-sync-review';
import { OfflineSyncStatusStore } from './offline-sync-status-store';
import { OfflineWorkspaceStore } from './offline-workspace-store';

/**
 * Renders preparation/connectivity and queue status plus the shared review panel.
 * Its polite live region reports background changes without taking focus; the
 * workspace and review stores own the state and recovery commands.
 */
@Component({
	selector: 'app-offline-status',
	imports: [OfflineSyncReview],
	templateUrl: './offline-status.html',
})
export class OfflineStatus {
	protected readonly sync = inject(OfflineSyncStatusStore);
	protected readonly store = inject(OfflineWorkspaceStore);
}
