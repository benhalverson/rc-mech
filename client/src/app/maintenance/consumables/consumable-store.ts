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
import { catchError, exhaustMap, of, switchMap, tap } from 'rxjs';
import type {
	ConsumableEntry,
	ConsumableMaintenanceDraft,
	MaintenanceGatewayFailure,
} from '../maintenance.models';
import { MaintenanceGateway } from '../maintenance-gateway';
import { MaintenanceWorkspaceStore } from '../maintenance-workspace-store';

export type ConsumableSaveCommand = {
	readonly kind: 'save';
	readonly mode: 'create' | 'edit';
	readonly carId: string;
	readonly id: string | null;
	readonly maintenance: ConsumableMaintenanceDraft;
};

export type ConsumableChangeCommand = {
	readonly kind: 'change';
	readonly action: 'archive' | 'restore';
	readonly entry: ConsumableEntry;
};

export type ConsumableCommand = ConsumableSaveCommand | ConsumableChangeCommand;

export type ConsumableFailure =
	| 'car-archived'
	| 'save-failed'
	| 'archive-failed'
	| 'restore-failed';

export type ConsumableOutcome =
	| { readonly status: 'idle'; readonly operationId: null }
	| {
			readonly status: 'pending' | 'succeeded';
			readonly operationId: number;
			readonly command: ConsumableCommand;
	  }
	| {
			readonly status: 'failed';
			readonly operationId: number;
			readonly command: ConsumableCommand;
			readonly failure: ConsumableFailure;
	  };

export type TireLookupOutcome =
	| { readonly status: 'idle'; readonly carId: null }
	| { readonly status: 'pending'; readonly carId: string }
	| {
			readonly status: 'succeeded';
			readonly carId: string;
			readonly tires: Record<string, unknown> | null;
	  }
	| { readonly status: 'failed'; readonly carId: string };

const idleOutcome = (): ConsumableOutcome => ({
	status: 'idle',
	operationId: null,
});

const resourceError = (
	failures: Array<MaintenanceGatewayFailure | null>,
): string => {
	if (
		failures.some(
			(failure) => failure?.kind === 'http' && failure.status === 401,
		)
	)
		return 'Your garage session has expired. Sign in again to continue.';
	return failures.some(Boolean)
		? 'Consumable history could not be loaded.'
		: '';
};

const mutationFailure = (
	command: ConsumableCommand,
	failure: MaintenanceGatewayFailure,
): ConsumableFailure => {
	if (command.kind === 'change')
		return command.action === 'archive' ? 'archive-failed' : 'restore-failed';
	if (failure.kind === 'http' && failure.status === 409) return 'car-archived';
	return 'save-failed';
};

/**
 * Projects tire/fluid history and reports for the Consumable editor. Prepared
 * changes enter MaintenanceWorkspaceStore with stable identities before success;
 * the route keeps editor outcomes and the existing online fallback, not a second
 * durable queue or independent service-association model.
 */
export const ConsumableStore = signalStore(
	withState<{
		outcome: ConsumableOutcome;
		tireLookup: TireLookupOutcome;
		localFailure: string;
	}>({
		localFailure: '',
		outcome: idleOutcome(),
		tireLookup: { status: 'idle', carId: null },
	}),
	withProps(() => ({
		gateway: inject(MaintenanceGateway),
		workspace: inject(MaintenanceWorkspaceStore),
		localRequest: {
			value: null as null | Readonly<{
				requestId: string;
				operationId: number;
				command: ConsumableCommand;
			}>,
		},
		nextOperationId: { value: 0 },
	})),
	withComputed((store) => {
		const failures = computed(() =>
			[
				store.gateway.cars.error(),
				store.gateway.timezone.error(),
				store.gateway.consumables.error(),
			].map((error) => store.gateway.failure(error)),
		);
		return {
			cars: computed(() =>
				store.workspace.available()
					? store.workspace.cars()
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
			entries: computed(() =>
				store.workspace.available()
					? store.workspace.consumables()
					: store.gateway.consumables.hasValue()
						? store.gateway.consumables.value()
						: [],
			),
			report: computed(() =>
				!store.workspace.available() && store.gateway.report.hasValue()
					? store.gateway.report.value()
					: null,
			),
			loading: computed(
				() =>
					!store.workspace.available() &&
					(store.gateway.cars.isLoading() ||
						store.gateway.timezone.isLoading() ||
						store.gateway.consumables.isLoading()),
			),
			error: computed(() =>
				store.workspace.available() ? '' : resourceError(failures()),
			),
			syncMessage: computed(
				() =>
					store.localFailure() ||
					(store.workspace.available()
						? store.workspace.consumableSyncMessage()
						: ''),
			),
			action: computed(() => {
				const outcome = store.outcome();
				if (outcome.status !== 'pending') return null;
				return outcome.command.kind === 'save'
					? outcome.command.mode
					: `${outcome.command.action}:${outcome.command.entry.id}`;
			}),
		};
	}),
	withMethods((store) => {
		const mutate = rxMethod<ConsumableCommand>((commands$) =>
			commands$.pipe(
				exhaustMap((command) => {
					const operationId = ++store.nextOperationId.value;
					patchState(store, {
						outcome: { status: 'pending', operationId, command },
					});
					const request =
						command.kind === 'save'
							? store.gateway.saveConsumable(
									command.mode,
									command.carId,
									command.id,
									command.maintenance,
								)
							: store.gateway.changeConsumable(command.entry, command.action);
					return request.pipe(
						tap(() => {
							store.gateway.consumables.reload();
							store.gateway.report.reload();
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
		const loadTires = rxMethod<string>((carIds$) =>
			carIds$.pipe(
				tap((carId) =>
					patchState(store, { tireLookup: { status: 'pending', carId } }),
				),
				switchMap((carId) =>
					store.gateway.currentTires(carId).pipe(
						tap((tires) =>
							patchState(store, {
								tireLookup: { status: 'succeeded', carId, tires },
							}),
						),
						catchError(() => {
							patchState(store, { tireLookup: { status: 'failed', carId } });
							return of(null);
						}),
					),
				),
			),
		);
		return {
			retry(): void {
				if (store.workspace.available()) store.workspace.refresh();
				store.gateway.cars.reload();
				store.gateway.timezone.reload();
				store.gateway.consumables.reload();
				store.gateway.report.reload();
			},
			clearOutcome(): void {
				store.localRequest.value = null;
				patchState(store, { outcome: idleOutcome(), localFailure: '' });
			},
			mutate(command: ConsumableCommand): void {
				if (store.outcome().status === 'pending') return;
				if (store.workspace.available()) {
					const operationId = ++store.nextOperationId.value;
					const requestId = crypto.randomUUID();
					store.localRequest.value = { requestId, operationId, command };
					patchState(store, {
						outcome: { status: 'pending', operationId, command },
						localFailure: '',
					});
					store.workspace.mutate({ requestId, change: command });
				} else mutate(command);
			},
			loadTires(carId: string): void {
				if (!carId) return;
				if (store.workspace.available())
					patchState(store, {
						tireLookup: {
							status: 'succeeded',
							carId,
							tires: store.workspace.tireSetups().get(carId) ?? null,
						},
					});
				else loadTires(carId);
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
