import {
	HttpClient,
	HttpErrorResponse,
	httpResource,
} from '@angular/common/http';
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

const carReadError = (error: unknown): string => {
	if (error instanceof HttpErrorResponse) {
		if (error.status === 401)
			return 'Your garage session has expired. Sign in again to continue.';
		if (error.status === 404)
			return 'Car not found. Return to the Garage collection and choose another car.';
	}
	return 'The car could not be loaded. Check the connection and try again.';
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
				? {
						url: `/api/v1/cars/${encodeURIComponent(id)}`,
						withCredentials: true,
					}
				: undefined;
		}),
	})),
	withComputed((store) => ({
		car: computed(() =>
			store.carResource.hasValue() ? store.carResource.value().car : null,
		),
		loading: computed(() => store.carResource.isLoading()),
		error: computed(() => {
			const error = store.carResource.error();
			return error ? carReadError(error) : '';
		}),
		notFound: computed(() => {
			const error = store.carResource.error();
			return error instanceof HttpErrorResponse && error.status === 404;
		}),
	})),
	withMethods((store) => ({
		selectCar(carId: string): void {
			if (store.carId() !== carId)
				patchState(store, {
					carId,
					lifecycleAction: null,
					lifecycleError: '',
				});
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
						`/api/v1/cars/${encodeURIComponent(carId)}/${action}`,
						{},
						{ withCredentials: true },
					),
				);
				if (store.carId() !== carId) return;
				store.carResource.reload();
				patchState(store, { lifecycleAction: null });
			} catch {
				if (store.carId() !== carId) return;
				patchState(store, {
					lifecycleAction: null,
					lifecycleError: `The car could not be ${action === 'archive' ? 'archived' : 'restored'}.`,
				});
			}
		},
	})),
);
