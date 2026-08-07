import { HttpErrorResponse, httpResource } from '@angular/common/http';
import { computed } from '@angular/core';
import {
	patchState,
	signalStore,
	withComputed,
	withMethods,
	withProps,
	withState,
} from '@ngrx/signals';
import type { CarPhoto } from './car/car.models';

export const CarPhotoStore = signalStore(
	withState({ carId: '' }),
	withProps(({ carId }) => ({
		resource: httpResource<{ photos: CarPhoto[] }>(() => {
			const id = carId();
			return id
				? {
						url: `/api/v1/cars/${encodeURIComponent(id)}/photos`,
						withCredentials: true,
					}
				: undefined;
		}),
	})),
	withComputed((store) => ({
		photos: computed(() =>
			store.resource.hasValue() ? store.resource.value().photos : [],
		),
		loading: computed(() => store.resource.isLoading()),
		error: computed(() => {
			const error = store.resource.error();
			if (!error) return '';
			return error instanceof HttpErrorResponse && error.status === 401
				? 'Your garage session has expired. Sign in again to continue.'
				: 'The photo gallery could not be loaded.';
		}),
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
