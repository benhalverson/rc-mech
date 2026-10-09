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
	MaintenancePlanDraft,
} from './maintenance.models';
import { MaintenanceGateway } from './maintenance-gateway';
import { MaintenanceWorkspaceStore } from './maintenance-workspace-store';

export type MaintenancePlanCommand =
	| {
			readonly kind: 'save-plan';
			readonly mode: 'create' | 'edit';
			readonly id: string | null;
			readonly plan: MaintenancePlanDraft;
	  }
	| {
			readonly kind: 'transition-plan';
			readonly planId: string;
			readonly action: 'pause' | 'resume' | 'archive' | 'restore';
	  };

export type MaintenancePlanFailure =
	| 'session-expired'
	| 'car-archived'
	| 'save-failed'
	| 'transition-failed';

export type MaintenancePlanOutcome =
	| { readonly status: 'idle'; readonly operationId: null }
	| {
			readonly status: 'pending' | 'succeeded';
			readonly operationId: number;
			readonly command: MaintenancePlanCommand;
	  }
	| {
			readonly status: 'failed';
			readonly operationId: number;
			readonly command: MaintenancePlanCommand;
			readonly failure: MaintenancePlanFailure;
	  };

const idleOutcome = (): MaintenancePlanOutcome => ({
	status: 'idle',
	operationId: null,
});

const requestFor = (
	gateway: MaintenanceGateway,
	command: MaintenancePlanCommand,
): Observable<unknown> =>
	command.kind === 'save-plan'
		? gateway.savePlan(command.mode, command.id, command.plan)
		: gateway.transitionPlan(command.planId, command.action);

const mutationFailure = (
	command: MaintenancePlanCommand,
	failure: MaintenanceGatewayFailure,
): MaintenancePlanFailure => {
	if (command.kind === 'transition-plan') return 'transition-failed';
	if (failure.kind === 'http' && failure.status === 401)
		return 'session-expired';
	if (failure.kind === 'http' && failure.status === 409) return 'car-archived';
	return 'save-failed';
};

const resourceMessage = (
	failures: Array<MaintenanceGatewayFailure | null>,
): string => {
	if (
		failures.some(
			(failure) => failure?.kind === 'http' && failure.status === 401,
		)
	)
		return 'Your garage session has expired. Sign in again to continue.';
	return failures.some(Boolean)
		? 'The maintenance ledger could not be loaded.'
		: '';
};

/**
 * Projects plans and due state for the Maintenance editor and dispatches plan
 * intents to the shared workspace when prepared. Keeps editor outcomes local to
 * the route while durable replay and usage baselines remain in the coordinator.
 */
export const MaintenancePlanStore = signalStore(
	withState<{
		outcome: MaintenancePlanOutcome;
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
				command: MaintenancePlanCommand;
			}>,
		},
		nextOperationId: { value: 0 },
	})),
	withComputed((store) => {
		const failures = computed(() =>
			[
				store.gateway.cars.error(),
				store.gateway.timezone.error(),
				store.gateway.plans.error(),
			].map((error) => store.gateway.failure(error)),
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
			plans: computed(() =>
				store.workspace.available()
					? store.workspace.plans()
					: store.gateway.plans.hasValue()
						? store.gateway.plans.value().plans
						: [],
			),
			loading: computed(
				() =>
					!store.workspace.available() &&
					((store.gateway.cars.isLoading() && !store.gateway.cars.hasValue()) ||
						(store.gateway.timezone.isLoading() &&
							!store.gateway.timezone.hasValue()) ||
						(store.gateway.plans.isLoading() &&
							!store.gateway.plans.hasValue())),
			),
			error: computed(
				() =>
					store.localFailure() ||
					(store.workspace.available() ? '' : resourceMessage(failures())),
			),
			syncMessage: computed(() => store.workspace.syncMessage()),
			action: computed(() => {
				const outcome = store.outcome();
				if (outcome.status === 'pending') {
					const command = outcome.command;
					return command.kind === 'save-plan'
						? command.mode
						: `${command.action}:${command.planId}`;
				}
				return !store.workspace.available() && store.gateway.plans.isLoading()
					? 'refresh'
					: null;
			}),
		};
	}),
	withMethods((store) => {
		const mutate = rxMethod<MaintenancePlanCommand>((commands$) =>
			commands$.pipe(
				exhaustMap((command) => {
					const operationId = ++store.nextOperationId.value;
					patchState(store, {
						outcome: { status: 'pending', operationId, command },
					});
					return requestFor(store.gateway, command).pipe(
						tap(() => {
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
				store.gateway.cars.reload();
				store.gateway.timezone.reload();
				store.gateway.plans.reload();
			},
			refresh(): void {
				if (store.workspace.available()) store.workspace.refresh();
				store.gateway.plans.reload();
			},
			clearOutcome(): void {
				store.localRequest.value = null;
				patchState(store, { localFailure: '' });
				patchState(store, { outcome: idleOutcome() });
			},
			mutate(command: MaintenancePlanCommand): void {
				if (store.outcome().status === 'pending') return;
				patchState(store, { localFailure: '' });
				if (store.workspace.available()) {
					const operationId = ++store.nextOperationId.value;
					const requestId = `plan:${operationId}`;
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
