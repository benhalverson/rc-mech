import { computed, inject } from '@angular/core';
import {
	patchState,
	signalStore,
	withComputed,
	withMethods,
	withProps,
	withState,
} from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import {
	catchError,
	exhaustMap,
	type Observable,
	of,
	switchMap,
	tap,
} from 'rxjs';
import { MaintenanceGateway } from './maintenance-gateway';
import type {
	MaintenanceComponent,
	MaintenanceGatewayFailure,
	ServiceRecordDraft,
} from './maintenance.models';

export type ServiceRecordCommand =
	| {
			readonly kind: 'save-service';
			readonly mode: 'create' | 'edit' | 'complete';
			readonly carId: string;
			readonly id: string | null;
			readonly service: ServiceRecordDraft;
	  }
	| {
			readonly kind: 'change-service';
			readonly recordId: string;
			readonly action: 'archive' | 'restore';
	  }
	| { readonly kind: 'undo-activity'; readonly recordId: string };

export type ServiceRecordFailure =
	| 'session-expired'
	| 'car-archived'
	| 'save-failed'
	| 'archive-failed'
	| 'restore-failed'
	| 'undo-failed';

export type ServiceRecordOutcome =
	| { readonly status: 'idle'; readonly operationId: null }
	| {
			readonly status: 'pending' | 'succeeded';
			readonly operationId: number;
			readonly command: ServiceRecordCommand;
	  }
	| {
			readonly status: 'failed';
			readonly operationId: number;
			readonly command: ServiceRecordCommand;
			readonly failure: ServiceRecordFailure;
	  };

const idleOutcome = (): ServiceRecordOutcome => ({
	status: 'idle',
	operationId: null,
});

const requestFor = (
	gateway: MaintenanceGateway,
	command: ServiceRecordCommand,
): Observable<unknown> => {
	switch (command.kind) {
		case 'save-service':
			return gateway.saveService(
				command.mode,
				command.carId,
				command.id,
				command.service,
			);
		case 'change-service':
			return gateway.changeService(command.recordId, command.action);
		case 'undo-activity':
			return gateway.changeService(command.recordId, 'archive');
	}
};

const mutationFailure = (
	command: ServiceRecordCommand,
	failure: MaintenanceGatewayFailure,
): ServiceRecordFailure => {
	if (command.kind === 'undo-activity') return 'undo-failed';
	if (command.kind === 'change-service')
		return command.action === 'archive' ? 'archive-failed' : 'restore-failed';
	if (failure.kind === 'http' && failure.status === 401)
		return 'session-expired';
	if (failure.kind === 'http' && failure.status === 409) return 'car-archived';
	return 'save-failed';
};

const resourceMessage = (failure: MaintenanceGatewayFailure | null): string => {
	if (failure?.kind === 'http' && failure.status === 401)
		return 'Your garage session has expired. Sign in again to continue.';
	return failure ? 'The maintenance ledger could not be loaded.' : '';
};

export const ServiceRecordStore = signalStore(
	withState<{
		outcome: ServiceRecordOutcome;
		components: MaintenanceComponent[];
	}>({ outcome: idleOutcome(), components: [] }),
	withProps(() => ({
		gateway: inject(MaintenanceGateway),
		nextOperationId: { value: 0 },
	})),
	withComputed((store) => {
		const records = computed(() =>
			store.gateway.services.hasValue() ? store.gateway.services.value() : [],
		);
		return {
			cars: computed(() =>
				store.gateway.cars.hasValue() ? store.gateway.cars.value() : [],
			),
			timezone: computed(() =>
				store.gateway.timezone.hasValue()
					? store.gateway.timezone.value()
					: 'UTC',
			),
			records,
			activity: computed(() => {
				const activity = store.gateway.plans.hasValue()
					? store.gateway.plans.value().activity
					: [];
				if (activity.length) return activity;
				return records()
					.filter((record) => !record.deletedAt)
					.map((record) => ({
						id: record.id,
						planId: record.planId ?? undefined,
						action: record.planId ? 'Scheduled service' : 'Ad hoc service',
						occurredAt: record.performedAt,
						note: record.description,
					}));
			}),
			loading: computed(
				() =>
					store.gateway.services.isLoading() &&
					!store.gateway.services.hasValue(),
			),
			error: computed(() =>
				resourceMessage(store.gateway.failure(store.gateway.services.error())),
			),
			action: computed(() => {
				const outcome = store.outcome();
				if (outcome.status !== 'pending') return null;
				const command = outcome.command;
				return command.kind === 'save-service'
					? command.mode
					: command.kind === 'change-service'
						? `${command.action === 'archive' ? 'delete' : 'restore'}:${command.recordId}`
						: null;
			}),
		};
	}),
	withMethods((store) => {
		const mutate = rxMethod<ServiceRecordCommand>((commands$) =>
			commands$.pipe(
				exhaustMap((command) => {
					const operationId = ++store.nextOperationId.value;
					patchState(store, {
						outcome: { status: 'pending', operationId, command },
					});
					return requestFor(store.gateway, command).pipe(
						tap(() => {
							store.gateway.services.reload();
							store.gateway.plans.reload();
							patchState(store, {
								outcome: { status: 'succeeded', operationId, command },
							});
						}),
						catchError((error: MaintenanceGatewayFailure) => {
							patchState(store, {
								outcome: {
									status: 'failed',
									operationId,
									command,
									failure: mutationFailure(command, error),
								},
							});
							return of(null);
						}),
					);
				}),
			),
		);
		const loadComponents = rxMethod<string>((carIds$) =>
			carIds$.pipe(
				switchMap((carId) =>
					carId
						? store.gateway.components(carId).pipe(
								tap((components) => patchState(store, { components })),
								catchError(() => {
									patchState(store, { components: [] });
									return of([]);
								}),
							)
						: of([]).pipe(tap(() => patchState(store, { components: [] }))),
				),
			),
		);
		return {
			retry(): void {
				store.gateway.services.reload();
			},
			refresh(): void {
				store.gateway.services.reload();
			},
			clearOutcome(): void {
				patchState(store, { outcome: idleOutcome() });
			},
			mutate(command: ServiceRecordCommand): void {
				if (store.outcome().status !== 'pending') mutate(command);
			},
			loadComponents(carId: string): void {
				loadComponents(carId);
			},
		};
	}),
);
