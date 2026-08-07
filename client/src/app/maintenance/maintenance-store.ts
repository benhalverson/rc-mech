import { HttpErrorResponse, httpResource } from '@angular/common/http';
import { computed } from '@angular/core';
import {
	signalStore,
	withComputed,
	withMethods,
	withProps,
} from '@ngrx/signals';
import type { ConsumableEntry } from '../consumable-maintenance';
import type {
	MaintenanceActivity,
	MaintenanceCar,
	MaintenancePlan,
	ServiceRecord,
} from '../maintenance-cockpit';

type PlansResponse = {
	maintenancePlans?: MaintenancePlan[];
	plans?: MaintenancePlan[];
	activity?: MaintenanceActivity[];
};

type CarsResponse = { cars: MaintenanceCar[] };
type TimezoneResponse = { timezone?: string };
type ServiceRecordsResponse = { serviceRecords?: ServiceRecord[] };
type ConsumableResponse = { consumableMaintenance?: ConsumableEntry[] };
export type MaintenanceReport = {
	tires: {
		frequency: {
			front: { eventCount: number; averageIntervalDays: number | null };
			rear: { eventCount: number; averageIntervalDays: number | null };
		};
		spend: {
			front: { total: number | null };
			rear: { total: number | null };
			combined: { total: number | null };
		};
	};
	fluidHistory: unknown[];
};
type ReportResponse = { report: MaintenanceReport };

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

const displayTimezone = (value: unknown): string =>
	isValidTimezone(value) ? value : browserTimezone();

const resourceMessage = (errors: unknown[]): string => {
	if (
		errors.some(
			(error) => error instanceof HttpErrorResponse && error.status === 401,
		)
	)
		return 'Your garage session has expired. Sign in again to continue.';
	return 'The maintenance ledger could not be loaded.';
};

export const MaintenanceStore = signalStore(
	withProps(() => ({
		carsResource: httpResource<CarsResponse>(() => ({
			url: '/api/v1/cars',
			withCredentials: true,
			params: { archived: 'all' },
		})),
		timezoneResource: httpResource<TimezoneResponse>(() => ({
			url: '/api/v1/preferences/timezone',
			withCredentials: true,
		})),
		plansResource: httpResource<PlansResponse>(() => ({
			url: '/api/v1/maintenance-plans',
			withCredentials: true,
		})),
		serviceResource: httpResource<ServiceRecordsResponse>(() => ({
			url: '/api/v1/service-records',
			withCredentials: true,
		})),
		consumableResource: httpResource<ConsumableResponse>(() => ({
			url: '/api/v1/consumable-maintenance',
			withCredentials: true,
		})),
		reportResource: httpResource<ReportResponse>(() => ({
			url: '/api/v1/consumables/report',
			withCredentials: true,
		})),
	})),
	withComputed((store) => {
		const cockpitErrors = computed(() =>
			[
				store.carsResource.error(),
				store.timezoneResource.error(),
				store.plansResource.error(),
				store.serviceResource.error(),
			].filter((error) => error !== undefined),
		);
		const consumableErrors = computed(() =>
			[
				store.carsResource.error(),
				store.timezoneResource.error(),
				store.consumableResource.error(),
				store.reportResource.error(),
			].filter((error) => error !== undefined),
		);
		const errors = computed(() =>
			[
				store.carsResource.error(),
				store.timezoneResource.error(),
				store.plansResource.error(),
				store.serviceResource.error(),
				store.consumableResource.error(),
				store.reportResource.error(),
			].filter((error) => error !== undefined),
		);
		const loading = computed(() =>
			[
				store.carsResource,
				store.timezoneResource,
				store.plansResource,
				store.serviceResource,
				store.consumableResource,
				store.reportResource,
			].some((resource) => resource.isLoading()),
		);
		const cockpitLoading = computed(() =>
			[
				store.carsResource,
				store.timezoneResource,
				store.plansResource,
				store.serviceResource,
			].some((resource) => resource.isLoading()),
		);
		const consumablesLoading = computed(() =>
			[
				store.carsResource,
				store.timezoneResource,
				store.consumableResource,
				store.reportResource,
			].some((resource) => resource.isLoading()),
		);
		const serviceRecords = computed(() =>
			store.serviceResource.hasValue()
				? (store.serviceResource.value().serviceRecords ?? [])
				: [],
		);
		return {
			cars: computed(() =>
				store.carsResource.hasValue() ? store.carsResource.value().cars : [],
			),
			timezone: computed(() =>
				store.timezoneResource.hasValue()
					? displayTimezone(store.timezoneResource.value().timezone)
					: browserTimezone(),
			),
			plans: computed(() =>
				store.plansResource.hasValue()
					? (store.plansResource.value().maintenancePlans ??
						store.plansResource.value().plans ??
						[])
					: [],
			),
			serviceRecords,
			activity: computed(() => {
				if (
					store.plansResource.hasValue() &&
					store.plansResource.value().activity?.length
				)
					return store.plansResource.value().activity ?? [];
				return serviceRecords()
					.filter((record) => !record.deletedAt)
					.map((record) => ({
						id: record.id,
						planId: record.planId ?? undefined,
						action: record.planId ? 'Scheduled service' : 'Ad hoc service',
						occurredAt: record.performedAt,
						note: record.description,
					}));
			}),
			consumableEntries: computed(() =>
				store.consumableResource.hasValue()
					? (store.consumableResource.value().consumableMaintenance ?? [])
					: [],
			),
			report: computed(() =>
				store.reportResource.hasValue()
					? store.reportResource.value().report
					: null,
			),
			cockpitLoading,
			cockpitError: computed(() =>
				cockpitErrors().length ? resourceMessage(cockpitErrors()) : '',
			),
			consumablesLoading,
			consumablesError: computed(() =>
				consumableErrors().length ? resourceMessage(consumableErrors()) : '',
			),
			loading,
			error: computed(() => (errors().length ? resourceMessage(errors()) : '')),
		};
	}),
	withMethods((store) => ({
		retryCockpit(): void {
			store.carsResource.reload();
			store.timezoneResource.reload();
			store.plansResource.reload();
			store.serviceResource.reload();
		},
		retryConsumables(): void {
			store.carsResource.reload();
			store.timezoneResource.reload();
			store.consumableResource.reload();
			store.reportResource.reload();
		},
		retryAll(): void {
			store.carsResource.reload();
			store.timezoneResource.reload();
			store.plansResource.reload();
			store.serviceResource.reload();
			store.consumableResource.reload();
			store.reportResource.reload();
		},
		refreshPlans(): void {
			store.plansResource.reload();
		},
		refreshServiceRecords(): void {
			store.serviceResource.reload();
		},
		refreshConsumables(): void {
			store.consumableResource.reload();
			store.reportResource.reload();
		},
	})),
);
