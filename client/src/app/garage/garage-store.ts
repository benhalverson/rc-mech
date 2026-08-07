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

export type GarageCar = {
	id: string;
	name: string;
	manufacturer?: string | null;
	make?: string | null;
	model?: string | null;
	scale?: string | null;
	vehicleType?: string | null;
	powerType?: string | null;
	notes?: string | null;
	archivedAt?: string | null;
	createdAt?: string;
};

export type GarageCarInput = {
	name: string;
	make?: string;
	model?: string;
	scale?: string;
	vehicleType?: string;
	powerType?: string;
	notes?: string;
};

type GarageState = {
	showArchived: boolean;
	carAction: 'create' | null;
	carMutationError: string;
	carMessage: string;
};

const collectionErrorMessage = (error: unknown): string => {
	if (error instanceof HttpErrorResponse && error.status === 401)
		return 'Your garage session has expired. Sign in again to continue.';
	return 'The garage could not be loaded. Check the connection and try again.';
};

export const GarageStore = signalStore(
	withState<GarageState>({
		showArchived: false,
		carAction: null,
		carMutationError: '',
		carMessage: '',
	}),
	withProps(({ showArchived }) => {
		const collection = httpResource<{ cars: GarageCar[] }>(() => ({
			url: '/api/v1/cars',
			withCredentials: true,
			params: showArchived() ? { archived: 'all' } : undefined,
		}));
		return { collection, http: inject(HttpClient) };
	}),
	withComputed((store) => {
		const cars = computed(() =>
			store.collection.hasValue() ? (store.collection.value()?.cars ?? []) : [],
		);
		return {
			cars,
			collectionLoading: computed(() => store.collection.isLoading()),
			collectionError: computed(() => {
				const error = store.collection.error();
				return error ? collectionErrorMessage(error) : '';
			}),
		};
	}),
	withMethods((store) => ({
		toggleArchived(): void {
			patchState(store, { showArchived: !store.showArchived() });
		},
		retryCollection(): void {
			store.collection.reload();
		},
		clearCarMutationState(): void {
			patchState(store, { carMutationError: '', carMessage: '' });
		},
		async createCar(input: GarageCarInput): Promise<GarageCar | null> {
			if (store.carAction()) return null;
			patchState(store, {
				carAction: 'create',
				carMutationError: '',
				carMessage: '',
			});
			try {
				const { car } = await firstValueFrom(
					store.http.post<{ car: GarageCar }>('/api/v1/cars', input, {
						withCredentials: true,
					}),
				);
				store.collection.reload();
				patchState(store, {
					carAction: null,
					carMessage: 'Car added to the garage.',
				});
				return car;
			} catch (error) {
				patchState(store, {
					carAction: null,
					carMutationError:
						error instanceof HttpErrorResponse && error.status === 401
							? 'Your garage session has expired. Sign in again to continue.'
							: 'The car could not be saved. Check the details and try again.',
				});
				return null;
			}
		},
	})),
);
