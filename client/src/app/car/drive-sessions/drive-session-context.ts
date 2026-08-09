import { computed, InjectionToken, inject, type Signal } from '@angular/core';
import {
	patchState,
	signalStore,
	withComputed,
	withMethods,
	withProps,
	withState,
} from '@ngrx/signals';
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

export const DriveSessionContextStore = signalStore(
	withState({ carId: '' }),
	withProps(() => ({ gateway: inject(DriveSessionGateway) })),
	withComputed((store) => ({
		sessions: computed(() =>
			store.gateway.collection.hasValue()
				? store.gateway.collection.value().sessions
				: [],
		),
		timezone: computed(() => {
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
