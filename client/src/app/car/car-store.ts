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
import type { GarageCar, GarageCarInput } from '../garage/garage-store';

type CarState = {
	carId: string | null;
	lifecycleAction: 'archive' | 'restore' | null;
	lifecycleError: string;
	carAction: 'update' | null;
	carMutationError: string;
	carMessage: string;
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
		carAction: null,
		carMutationError: '',
		carMessage: '',
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
					carAction: null,
					carMutationError: '',
					carMessage: '',
				});
		},
		retry(): void {
			store.carResource.reload();
		},
		refresh(): void {
			store.carResource.reload();
		},
		clearCarMutationState(): void {
			patchState(store, { carMutationError: '', carMessage: '' });
		},
		async updateCar(input: GarageCarInput): Promise<boolean> {
			const carId = store.carId();
			if (!carId || store.carAction() || store.lifecycleAction()) return false;
			patchState(store, {
				carAction: 'update',
				carMutationError: '',
				carMessage: '',
			});
			try {
				await firstValueFrom(
					store.http.patch(`/api/v1/cars/${encodeURIComponent(carId)}`, input, {
						withCredentials: true,
					}),
				);
				if (store.carId() !== carId) return false;
				store.carResource.reload();
				patchState(store, {
					carAction: null,
					carMessage: 'Car details saved.',
				});
				return true;
			} catch (error) {
				if (store.carId() !== carId) return false;
				patchState(store, {
					carAction: null,
					carMutationError:
						error instanceof HttpErrorResponse && error.status === 401
							? 'Your garage session has expired. Sign in again to continue.'
							: 'The car could not be saved. Check the details and try again.',
				});
				return false;
			}
		},
		async changeArchiveState(action: 'archive' | 'restore'): Promise<void> {
			const carId = store.carId();
			if (!carId || store.lifecycleAction() || store.carAction()) return;
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
			} catch (error) {
				if (store.carId() !== carId) return;
				patchState(store, {
					lifecycleAction: null,
					lifecycleError:
						error instanceof HttpErrorResponse && error.status === 401
							? 'Your garage session has expired. Sign in again to continue.'
							: `The car could not be ${action === 'archive' ? 'archived' : 'restored'}.`,
				});
			}
		},
	})),
);
