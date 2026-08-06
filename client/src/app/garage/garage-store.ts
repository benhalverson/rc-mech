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
};

export const GarageStore = signalStore(
	withState<GarageState>({ activeCarId: null, showArchived: false }),
	withProps(({ showArchived }) => {
		const collection = httpResource<{ cars: GarageCar[] }>(() => ({
			url: '/api/v1/cars',
			withCredentials: true,
			params: showArchived() ? { archived: 'all' } : undefined,
		}));
		return { collection };
	}),
	withComputed((store) => {
		const cars = computed(() =>
			store.collection.hasValue() ? (store.collection.value()?.cars ?? []) : [],
		);
		return {
			cars,
			activeCar: computed(
				() =>
					cars().find((car: GarageCar) => car.id === store.activeCarId()) ??
					null,
			),
			collectionLoading: computed(() => store.collection.isLoading()),
			collectionError: computed(() => store.collection.error()),
		};
	}),
	withMethods((store) => ({
		selectCar(activeCarId: string | null): void {
			patchState(store, { activeCarId });
		},
		setArchivedFilter(showArchived: boolean): void {
			patchState(store, { showArchived, activeCarId: null });
		},
		toggleArchived(): void {
			patchState(store, {
				showArchived: !store.showArchived(),
				activeCarId: null,
			});
		},
		retryCollection(): void {
			store.collection.reload();
		},
	})),
);
