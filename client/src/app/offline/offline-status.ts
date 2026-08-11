import { Component, inject } from '@angular/core';
import { OfflineWorkspaceStore } from './offline-workspace-store';

@Component({
	selector: 'app-offline-status',
	templateUrl: './offline-status.html',
})
export class OfflineStatus {
	protected readonly store = inject(OfflineWorkspaceStore);
}
