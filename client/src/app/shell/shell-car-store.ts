import { computed, inject } from '@angular/core';
import {
	signalStore,
	withComputed,
	withMethods,
	withProps,
} from '@ngrx/signals';
import { OfflineWorkspaceStore } from '../offline/offline-workspace-store';
import { ShellCarGateway } from './shell-car-gateway';
import { ShellRouteContext } from './shell-route-context';

const collectionFailure =
	'The garage cars could not be loaded. Check the connection and try again.';

export const ShellCarStore = signalStore(
	{ providedIn: 'root' },
	withProps(() => ({
		gateway: inject(ShellCarGateway),
		offline: inject(OfflineWorkspaceStore),
		route: inject(ShellRouteContext),
	})),
	withComputed((store) => {
		const cars = computed(() =>
			store.gateway.collection.hasValue()
				? store.gateway.collection.value().cars
				: store.offline.hasSnapshot()
					? store.offline.cars().map((car) => ({
							id: car.id,
							name: car.name,
							archivedAt: car.archivedAt ?? null,
						}))
					: [],
		);
		return {
			cars,
			carId: store.route.carId,
			section: store.route.section,
			inCarWorkspace: computed(() => store.route.carId() !== null),
			currentCar: computed(() => {
				const carId = store.route.carId();
				return carId ? (cars().find((car) => car.id === carId) ?? null) : null;
			}),
			loading: computed(
				() =>
					store.route.carId() !== null &&
					!store.offline.hasSnapshot() &&
					store.gateway.collection.isLoading(),
			),
			error: computed(() =>
				store.route.carId() !== null &&
				!store.offline.hasSnapshot() &&
				store.gateway.collection.error()
					? collectionFailure
					: '',
			),
		};
	}),
	withMethods((store) => ({
		retry(): void {
			store.gateway.refresh();
		},
	})),
);
