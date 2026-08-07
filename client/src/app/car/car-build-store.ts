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
import { carReadFailure } from './car-read-failure';
import type { InstalledComponent } from './car.models';

const installationTime = (component: InstalledComponent): number => {
	const timestamp = component.installedAt
		? Date.parse(component.installedAt)
		: Number.NaN;
	return Number.isNaN(timestamp) ? 0 : timestamp;
};

export const CarBuildStore = signalStore(
	withState({ carId: '' }),
	withProps(({ carId }) => ({
		resource: httpResource<{ components: InstalledComponent[] }>(() => {
			const id = carId();
			return id
				? {
						url: `/api/v1/cars/${encodeURIComponent(id)}/components`,
						withCredentials: true,
						params: { history: 'true' },
					}
				: undefined;
		}),
	})),
	withComputed((store) => {
		const components = computed(() =>
			store.resource.hasValue() ? store.resource.value().components : [],
		);
		return {
			components,
			failure: computed(() =>
				carReadFailure(
					store.resource.error(),
					'The build sheet could not be loaded.',
				),
			),
			groups: computed(() => {
				const grouped = new Map<string, InstalledComponent[]>();
				for (const component of components())
					grouped.set(component.slot, [
						...(grouped.get(component.slot) ?? []),
						component,
					]);
				return [...grouped.entries()].map(([slot, items]) => {
					const newestFirst = [...items].sort(
						(left, right) => installationTime(right) - installationTime(left),
					);
					return {
						slot,
						current: newestFirst.find((item) => !item.removedAt) ?? null,
						history: newestFirst.filter((item) => item.removedAt),
					};
				});
			}),
			loading: computed(() => store.resource.isLoading()),
		};
	}),
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
