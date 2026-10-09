import { computed, inject } from '@angular/core';
import { signalStore, withComputed, withProps } from '@ngrx/signals';
import { PhotoWorkspaceStore } from '../car/photos/photo-workspace-store';
import { CarWorkspaceStore } from '../garage/car-sync/car-workspace-store';
import { MaintenanceWorkspaceStore } from '../maintenance/maintenance-workspace-store';
import { SettingsWorkspaceStore } from '../settings/settings-workspace-store';
import { VoiceWorkspaceStore } from '../voice/voice-workspace-store';
import { OfflineWorkspaceStore } from './offline-workspace-store';

/**
 * Read-only summary of pending, syncing, rejected, and conflicting work from the
 * shared coordinators. The shell uses this owner-fenced projection for one status
 * message; it neither starts replay nor moves focus when background state changes.
 */
export const OfflineSyncStatusStore = signalStore(
	{ providedIn: 'root' },
	withProps(() => ({
		offline: inject(OfflineWorkspaceStore),
		cars: inject(CarWorkspaceStore),
		maintenance: inject(MaintenanceWorkspaceStore),
		settings: inject(SettingsWorkspaceStore),
		photos: inject(PhotoWorkspaceStore),
		voice: inject(VoiceWorkspaceStore),
	})),
	withComputed((store) => ({
		message: computed(() => {
			if (!store.offline.hasSnapshot()) return '';
			const statuses = [
				...store.cars.operations(),
				...store.cars.setupOperations(),
				...store.cars.buildOperations(),
				...store.cars.driveOperations(),
				...store.maintenance.operations(),
				...store.settings.operations(),
				...store.photos.captures(),
				...store.photos.changes(),
			].map((operation) => operation.status);
			statuses.push(
				...store.voice
					.captures()
					.map((capture) =>
						capture.status === 'failed'
							? ('needs-attention' as const)
							: ('pending' as const),
					),
			);
			const syncing =
				store.cars.syncingOperationIds().length > 0 ||
				store.maintenance.syncing() ||
				store.settings.syncing() ||
				store.photos.syncing() ||
				store.voice.syncing();
			return [
				syncing ? 'Syncing' : '',
				...(['pending', 'needs-attention', 'conflict'] as const).map(
					(status) => {
						const count = statuses.filter((value) => value === status).length;
						const labels = {
							pending: 'Pending sync',
							'needs-attention': 'Needs attention',
							conflict: 'Sync conflict',
						};
						return count ? `${labels[status]}: ${count}` : '';
					},
				),
			]
				.filter(Boolean)
				.join(' · ');
		}),
	})),
);
