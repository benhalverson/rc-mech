import { computed, InjectionToken, inject, type Signal } from '@angular/core';
import {
	patchState,
	signalStore,
	withComputed,
	withMethods,
	withProps,
	withState,
} from '@ngrx/signals';
import { CarWorkspaceStore } from '../../garage/car-sync/car-workspace-store';
import { OfflineWorkspaceStore } from '../../offline/offline-workspace-store';
import type { DriveSession } from './drive-session.models';
import { DriveSessionGateway } from './drive-session-gateway';
import { resolveTimezone } from './drive-session-time';

export type DriveSessionContext = {
	readonly sessions: Signal<readonly DriveSession[]>;
	readonly timezone: Signal<string>;
	selectCar(carId: string): void;
};

export const DRIVE_SESSION_CONTEXT = new InjectionToken<DriveSessionContext>(
	'DRIVE_SESSION_CONTEXT',
);

/**
 * Exposes the current Car's Drive-session selection through DRIVE_SESSION_CONTEXT
 * to Voice workflows. Keeps that read context separate from the Drive editor
 * store so Voice can attach an outing without depending on a sibling workflow.
 */
export const DriveSessionContextStore = signalStore(
	withState({ carId: '' }),
	withProps(() => ({
		gateway: inject(DriveSessionGateway),
		workspace: inject(CarWorkspaceStore),
		offline: inject(OfflineWorkspaceStore),
	})),
	withComputed((store) => ({
		sessions: computed(() =>
			store.offline.hasSnapshot()
				? (store.workspace
						.driveCollections()
						.find((collection) => collection.carId === store.carId())
						?.sessions ?? [])
				: store.gateway.collection.hasValue()
					? store.gateway.collection.value().sessions
					: [],
		),
		timezone: computed(() => {
			if (store.offline.hasSnapshot())
				return resolveTimezone(
					store.workspace
						.driveCollections()
						.find((collection) => collection.carId === store.carId())?.timezone,
					null,
				);
			const collectionTimezone = store.gateway.collection.hasValue()
				? store.gateway.collection.value().timezone
				: null;
			const preferenceTimezone = store.gateway.timezone.hasValue()
				? store.gateway.timezone.value().timezone
				: null;
			return resolveTimezone(collectionTimezone, preferenceTimezone);
		}),
	})),
	withMethods((store) => ({
		selectCar(carId: string): void {
			if (store.carId() === carId) return;
			patchState(store, { carId });
			store.gateway.selectCar(carId);
		},
	})),
);
