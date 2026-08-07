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
import type { DriveSession } from './car.models';

const isValidTimezone = (value: unknown): value is string => {
	if (typeof value !== 'string' || !value.trim()) return false;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
		return true;
	} catch {
		return false;
	}
};

const browserTimezone = (): string => {
	try {
		const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		return isValidTimezone(timezone) ? timezone : 'UTC';
	} catch {
		return 'UTC';
	}
};

export const safeTimezone = (value: unknown): string =>
	isValidTimezone(value) ? value : browserTimezone();

export const CarRunsStore = signalStore(
	withState({ carId: '' }),
	withProps(({ carId }) => ({
		sessionsResource: httpResource<{
			driveSessions?: DriveSession[];
			sessions?: DriveSession[];
		}>(() => {
			const id = carId();
			return id
				? {
						url: `/api/v1/cars/${encodeURIComponent(id)}/drives`,
						withCredentials: true,
						params: { history: 'true' },
					}
				: undefined;
		}),
		timezoneResource: httpResource<{ timezone?: string }>(() => ({
			url: '/api/v1/preferences/timezone',
			withCredentials: true,
		})),
	})),
	withComputed((store) => {
		const sessions = computed(() =>
			store.sessionsResource.hasValue()
				? (store.sessionsResource.value().driveSessions ??
					store.sessionsResource.value().sessions ??
					[])
				: [],
		);
		return {
			sessions,
			failure: computed(() =>
				carReadFailure(
					store.sessionsResource.error(),
					'The run log could not be loaded.',
				),
			),
			activeCount: computed(
				() => sessions().filter((session) => !session.deletedAt).length,
			),
			timezone: computed(() =>
				store.timezoneResource.hasValue()
					? safeTimezone(store.timezoneResource.value().timezone)
					: browserTimezone(),
			),
			loading: computed(() => store.sessionsResource.isLoading()),
		};
	}),
	withMethods((store) => ({
		selectCar(carId: string): void {
			if (store.carId() !== carId) patchState(store, { carId });
		},
		retry(): void {
			store.sessionsResource.reload();
		},
		refresh(): void {
			store.sessionsResource.reload();
		},
	})),
);
