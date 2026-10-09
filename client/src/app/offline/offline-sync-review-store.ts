import { computed, inject } from '@angular/core';
import {
	patchState,
	signalStore,
	withComputed,
	withMethods,
	withProps,
	withState,
} from '@ngrx/signals';
import { PhotoWorkspaceStore } from '../car/photos/photo-workspace-store';
import { CarWorkspaceStore } from '../garage/car-sync/car-workspace-store';
import { MaintenanceWorkspaceStore } from '../maintenance/maintenance-workspace-store';
import { SettingsWorkspaceStore } from '../settings/settings-workspace-store';
import { VoiceWorkspaceStore } from '../voice/voice-workspace-store';
import { OfflineGarageStorage } from './offline-garage-storage';
import type { ReviewDecision, SyncReview } from './offline-sync-review.models';
import { OfflineWorkspaceStore } from './offline-workspace-store';

/**
 * Cross-workflow coordinator for retained conflicts and rejected commands.
 * Collects owner-scoped reviews, commits a retry/discard decision atomically via
 * storage, and reloads affected coordinators. Stored review evidence must still
 * match, so a stale review cannot silently overwrite a newer remote version.
 */
export const OfflineSyncReviewStore = signalStore(
	{ providedIn: 'root' },
	withState<{ pending: boolean; error: string }>({ pending: false, error: '' }),
	withProps(() => ({
		offline: inject(OfflineWorkspaceStore),
		storage: inject(OfflineGarageStorage),
		cars: inject(CarWorkspaceStore),
		maintenance: inject(MaintenanceWorkspaceStore),
		settings: inject(SettingsWorkspaceStore),
		voice: inject(VoiceWorkspaceStore),
		photos: inject(PhotoWorkspaceStore),
	})),
	withComputed((store) => ({
		names: computed(() =>
			Object.fromEntries([
				...store.cars.cars().map((car) => [car.id, car.name]),
				...store.cars
					.buildCollections()
					.flatMap((collection) =>
						collection.components.map((component) => [
							component.id,
							component.name,
						]),
					),
				...store.cars
					.setupCollections()
					.flatMap((collection) =>
						collection.setups.map((setup) => [setup.id, setup.name]),
					),
				...store.maintenance.plans().map((plan) => [plan.id, plan.name]),
			]),
		),
		reviews: computed<readonly SyncReview[]>(() =>
			store.offline.hasSnapshot()
				? [
						...store.photos
							.changes()
							.map((operation) => ({ family: 'photo' as const, operation })),
						...store.cars
							.operations()
							.map((operation) => ({ family: 'car' as const, operation })),
						...store.cars
							.setupOperations()
							.map((operation) => ({ family: 'setup' as const, operation })),
						...store.cars
							.buildOperations()
							.map((operation) => ({ family: 'build' as const, operation })),
						...store.cars
							.driveOperations()
							.map((operation) => ({ family: 'drive' as const, operation })),
						...store.maintenance.operations().map((operation) => ({
							family: 'maintenance' as const,
							operation,
						})),
						...store.settings
							.operations()
							.map((operation) => ({ family: 'settings' as const, operation })),
					].filter((review) => review.operation.status !== 'pending')
				: [],
		),
	})),
	withMethods((store) => ({
		resolve(review: SyncReview, decision: ReviewDecision): void {
			if (store.pending()) return;
			const fence = {
				ownerKey: store.offline.ownerKey(),
				sessionKey: store.offline.sessionKey(),
			};
			patchState(store, { pending: true, error: '' });
			void store.storage
				.resolveSyncReview(review, decision, fence)
				.then(() => {
					store.cars.open();
					store.maintenance.open();
					store.settings.open();
					store.voice.open();
					store.photos.open();
				})
				.catch(() => {
					if (
						fence.ownerKey === store.offline.ownerKey() &&
						fence.sessionKey === store.offline.sessionKey()
					)
						patchState(store, {
							error:
								'This review could not be saved. Your device changes remain available; reopen the review and try again.',
						});
				})
				.finally(() => patchState(store, { pending: false }));
		},
	})),
);
