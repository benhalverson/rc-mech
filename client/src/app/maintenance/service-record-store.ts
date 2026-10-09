import { computed, effect, inject } from '@angular/core';
import {
	patchState,
	signalStore,
	withComputed,
	withHooks,
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
import type {
	MaintenanceComponent,
	MaintenanceGatewayFailure,
	ServiceRecordDraft,
} from './maintenance.models';
import { MaintenanceGateway } from './maintenance-gateway';
import { MaintenanceWorkspaceStore } from './maintenance-workspace-store';

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

/**
 * Route workflow for recording service and editing its history. Uses the shared
 * Maintenance workspace to retain intent and captured usage baselines, keeping
 * local success distinct from remote acknowledgement; falls back to HTTP before
 * preparation rather than owning a second queue.
 */
export const ServiceRecordStore = signalStore(
	withState<{
		outcome: ServiceRecordOutcome;
		loadedComponents: MaintenanceComponent[];
		selectedCarId: string;
		localFailure: string;
	}>({
		outcome: idleOutcome(),
		loadedComponents: [],
		selectedCarId: '',
		localFailure: '',
	}),
	withProps(() => ({
		gateway: inject(MaintenanceGateway),
		workspace: inject(MaintenanceWorkspaceStore),
		localRequest: {
			value: null as null | Readonly<{
				requestId: string;
				operationId: number;
				command: ServiceRecordCommand;
			}>,
		},
		nextOperationId: { value: 0 },
	})),
	withComputed((store) => {
		const records = computed(() =>
			store.workspace.available()
				? store.workspace.records()
				: store.gateway.services.hasValue()
					? store.gateway.services.value()
					: [],
		);
		return {
			components: computed(() =>
				store.workspace.available()
					? [
							...store.workspace
								.components()
								.filter(
									(component) => component.carId === store.selectedCarId(),
								),
						]
					: store.loadedComponents(),
			),
			cars: computed(() =>
				store.workspace.available()
					? [...store.workspace.cars()]
					: store.gateway.cars.hasValue()
						? store.gateway.cars.value()
						: [],
			),
			timezone: computed(() =>
				store.workspace.available()
					? store.workspace.timezone()
					: store.gateway.timezone.hasValue()
						? store.gateway.timezone.value()
						: 'UTC',
			),
			records,
			activity: computed(() => {
				const activity =
					!store.workspace.available() && store.gateway.plans.hasValue()
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
					!store.workspace.available() &&
					store.gateway.services.isLoading() &&
					!store.gateway.services.hasValue(),
			),
			error: computed(
				() =>
					store.localFailure() ||
					(store.workspace.available()
						? ''
						: resourceMessage(
								store.gateway.failure(store.gateway.services.error()),
							)),
			),
			action: computed(() => {
				const outcome = store.outcome();
				if (outcome.status === 'pending') {
					const command = outcome.command;
					return command.kind === 'save-service'
						? command.mode
						: command.kind === 'change-service'
							? `${command.action === 'archive' ? 'delete' : 'restore'}:${command.recordId}`
							: `undo:${command.recordId}`;
				}
				return !store.workspace.available() &&
					(store.gateway.services.isLoading() ||
						store.gateway.plans.isLoading())
					? 'refresh'
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
								tap((components) =>
									patchState(store, { loadedComponents: components }),
								),
								catchError(() => {
									patchState(store, { loadedComponents: [] });
									return of([]);
								}),
							)
						: of([]).pipe(
								tap(() => patchState(store, { loadedComponents: [] })),
							),
				),
			),
		);
		return {
			retry(): void {
				store.workspace.synchronize();
				if (store.workspace.available()) store.workspace.refresh();
				store.gateway.services.reload();
			},
			refresh(): void {
				if (store.workspace.available()) store.workspace.refresh();
				store.gateway.services.reload();
			},
			clearOutcome(): void {
				store.localRequest.value = null;
				patchState(store, { localFailure: '' });
				patchState(store, { outcome: idleOutcome() });
			},
			mutate(command: ServiceRecordCommand): void {
				if (store.outcome().status === 'pending') return;
				patchState(store, { localFailure: '' });
				if (store.workspace.available()) {
					const operationId = ++store.nextOperationId.value;
					const requestId = `service:${operationId}`;
					store.localRequest.value = { requestId, operationId, command };
					patchState(store, {
						outcome: { status: 'pending', operationId, command },
					});
					store.workspace.mutate({ requestId, change: command });
					return;
				}
				mutate(command);
			},
			loadComponents(carId: string): void {
				patchState(store, { selectedCarId: carId });
				if (!store.workspace.available()) loadComponents(carId);
			},
		};
	}),
	withHooks((store) => ({
		onInit() {
			effect(() => {
				const result = store.workspace.outcome();
				const request = store.localRequest.value;
				if (
					!request ||
					result.requestId !== request.requestId ||
					result.status === 'pending'
				)
					return;
				if (result.status === 'succeeded')
					patchState(store, {
						outcome: {
							status: 'succeeded',
							operationId: request.operationId,
							command: request.command,
						},
					});
				else
					patchState(store, {
						localFailure: result.message,
						outcome: {
							status: 'failed',
							operationId: request.operationId,
							command: request.command,
							failure: mutationFailure(request.command, {
								kind: 'unavailable',
							}),
						},
					});
			});
		},
	})),
);
