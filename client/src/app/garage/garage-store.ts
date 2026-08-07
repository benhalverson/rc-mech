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
				? { url: `/api/v1/cars/${carId}`, withCredentials: true }
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
			collectionError: computed(() => store.collection.error()),
			overviewLoading: computed(() => store.overview.isLoading()),
			overviewError: computed(() => store.overview.error()),
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
						`/api/v1/cars/${carId}/${action}`,
						{},
						{ withCredentials: true },
					),
				);
				store.collection.reload();
				store.overview.reload();
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
