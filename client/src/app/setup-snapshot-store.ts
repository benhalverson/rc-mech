import { httpResource } from '@angular/common/http';
import { computed } from '@angular/core';
import {
	patchState,
	signalStore,
	withComputed,
	withMethods,
	withProps,
	withState,
} from '@ngrx/signals';
import { carReadFailure } from './car/car-read-failure';
import type { SetupSnapshot } from './setup-snapshot';

export const SetupSnapshotStore = signalStore(
	withState({ carId: '' }),
	withProps(({ carId }) => ({
		resource: httpResource<{ setups: SetupSnapshot[] }>(() => {
			const id = carId();
			return id
				? {
						url: `/api/v1/cars/${encodeURIComponent(id)}/setups`,
						withCredentials: true,
					}
				: undefined;
		}),
	})),
	withComputed((store) => ({
		setups: computed(() =>
			store.resource.hasValue() ? store.resource.value().setups : [],
		),
		loading: computed(() => store.resource.isLoading()),
		failure: computed(() =>
			carReadFailure(
				store.resource.error(),
				'Setup history could not be loaded. Check the connection and try again.',
			),
		),
	})),
	withMethods((store) => ({
		selectCar(carId: string): void {
			if (store.carId() !== carId) patchState(store, { carId });
		},
		retry(): void {
			store.resource.reload();
		},
		refresh(): void {
			store.resource.reload();
		},
	})),
);
