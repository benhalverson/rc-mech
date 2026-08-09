import { httpResource } from '@angular/common/http';
import { computed } from '@angular/core';
import {
	signalStore,
	withComputed,
	withMethods,
	withProps,
} from '@ngrx/signals';
import type { GarageCar } from '../../garage/garage-store';
import { carReadFailure } from '../car-read-failure';

export const CarSetupsStore = signalStore(
	withProps(() => ({
		collection: httpResource<{ cars: GarageCar[] }>(() => ({
			url: '/api/v1/cars',
			withCredentials: true,
		})),
	})),
	withComputed((store) => ({
		availableCars: computed(() =>
			store.collection.hasValue() ? store.collection.value().cars : [],
		),
		loading: computed(() => store.collection.isLoading()),
		failure: computed(() =>
			carReadFailure(
				store.collection.error(),
				'The garage list needed for setup imports could not be loaded.',
			),
		),
	})),
	withMethods((store) => ({
		retry(): void {
			store.collection.reload();
		},
		refresh(): void {
			store.collection.reload();
		},
	})),
);
