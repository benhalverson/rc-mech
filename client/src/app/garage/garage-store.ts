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

type GarageState = {
	activeCarId: string | null;
	showArchived: boolean;
	lifecycleAction: 'archive' | 'restore' | null;
	lifecycleError: string;
};

const readErrorMessage = (
	error: unknown,
	fallback: string,
	notFound?: string,
): string => {
	if (error instanceof HttpErrorResponse) {
		if (error.status === 401)
			return 'Your garage session has expired. Sign in again to continue.';
		if (error.status === 404 && notFound) return notFound;
	}
	return fallback;
};

export const GarageStore = signalStore(
	withState<GarageState>({
		activeCarId: null,
		showArchived: false,
		lifecycleAction: null,
		lifecycleError: '',
	}),
	withProps(({ activeCarId, showArchived }) => {
		const collection = httpResource<{ cars: GarageCar[] }>(() => ({
			url: '/api/v1/cars',
			withCredentials: true,
			params: showArchived() ? { archived: 'all' } : undefined,
		}));
		const overview = httpResource<{ car: GarageCar }>(() => {
			const carId = activeCarId();
			return carId
				? {
						url: `/api/v1/cars/${encodeURIComponent(carId)}`,
						withCredentials: true,
					}
				: undefined;
		});
		return { collection, overview, http: inject(HttpClient) };
	}),
	withComputed((store) => {
		const cars = computed(() =>
			store.collection.hasValue() ? (store.collection.value()?.cars ?? []) : [],
		);
		return {
			cars,
			activeCar: computed(() =>
				store.overview.hasValue()
					? store.overview.value().car
					: (cars().find((car: GarageCar) => car.id === store.activeCarId()) ??
						null),
			),
			collectionLoading: computed(() => store.collection.isLoading()),
			collectionError: computed(() => {
				const error = store.collection.error();
				return error
					? readErrorMessage(
							error,
							'The garage could not be loaded. Check the connection and try again.',
						)
					: '';
			}),
			overviewLoading: computed(() => store.overview.isLoading()),
			overviewError: computed(() => {
				const error = store.overview.error();
				return error
					? readErrorMessage(
							error,
							'The car overview could not be loaded. Check the connection and try again.',
							'Car not found. Return to the Garage collection and choose another car.',
						)
					: '';
			}),
			overviewNotFound: computed(() => {
				const error = store.overview.error();
				return error instanceof HttpErrorResponse && error.status === 404;
			}),
		};
	}),
	withMethods((store) => ({
		selectCar(activeCarId: string | null): void {
			patchState(store, {
				activeCarId,
				lifecycleAction: null,
				lifecycleError: '',
			});
		},
		setArchivedFilter(showArchived: boolean): void {
			patchState(store, {
				showArchived,
				activeCarId: null,
				lifecycleAction: null,
				lifecycleError: '',
			});
		},
		toggleArchived(): void {
			patchState(store, {
				showArchived: !store.showArchived(),
				activeCarId: null,
				lifecycleAction: null,
				lifecycleError: '',
			});
		},
		retryCollection(): void {
			store.collection.reload();
		},
		retryOverview(): void {
			store.overview.reload();
		},
		async changeArchiveState(action: 'archive' | 'restore'): Promise<void> {
			const carId = store.activeCarId();
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
				if (store.activeCarId() !== carId) return;
				store.collection.reload();
				store.overview.reload();
				patchState(store, { lifecycleAction: null });
			} catch {
				if (store.activeCarId() !== carId) return;
				patchState(store, {
					lifecycleAction: null,
					lifecycleError: `The car could not be ${action === 'archive' ? 'archived' : 'restored'}.`,
				});
			}
		},
	})),
);
