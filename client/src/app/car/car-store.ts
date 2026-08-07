import { HttpClient, httpResource } from '@angular/common/http';
import { computed, inject } from '@angular/core';
import {
	patchState,
	signalStore,
	withComputed,
	withMethods,
	withProps,
	withState,
} from '@ngrx/signals';
import { firstValueFrom } from 'rxjs';
import type { GarageCar } from '../garage/garage-store';

type CarState = {
	carId: string | null;
	lifecycleAction: 'archive' | 'restore' | null;
	lifecycleError: string;
};

export const CarStore = signalStore(
	withState<CarState>({
		carId: null,
		lifecycleAction: null,
		lifecycleError: '',
	}),
	withProps(({ carId }) => ({
		http: inject(HttpClient),
		carResource: httpResource<{ car: GarageCar }>(() => {
			const id = carId();
			return id
				? { url: `/api/v1/cars/${id}`, withCredentials: true }
				: undefined;
		}),
	})),
	withComputed((store) => ({
		car: computed(() =>
			store.carResource.hasValue() ? store.carResource.value().car : null,
		),
		loading: computed(() => store.carResource.isLoading()),
		error: computed(() => store.carResource.error()),
	})),
	withMethods((store) => ({
		selectCar(carId: string): void {
			if (store.carId() !== carId)
				patchState(store, { carId, lifecycleError: '' });
		},
		retry(): void {
			store.carResource.reload();
		},
		refresh(): void {
			store.carResource.reload();
		},
		async changeArchiveState(action: 'archive' | 'restore'): Promise<void> {
			const carId = store.carId();
			if (!carId || store.lifecycleAction()) return;
			patchState(store, { lifecycleAction: action, lifecycleError: '' });
			try {
				await firstValueFrom(
					store.http.post(
						`/api/v1/cars/${carId}/${action}`,
						{},
						{ withCredentials: true },
					),
				);
				store.carResource.reload();
				patchState(store, { lifecycleAction: null });
			} catch {
				patchState(store, {
					lifecycleAction: null,
					lifecycleError: `The car could not be ${action === 'archive' ? 'archived' : 'restored'}.`,
				});
			}
		},
	})),
);
