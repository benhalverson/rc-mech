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
	MaintenancePlanDraft,
} from './maintenance.models';

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
			readonly action: 'pause' | 'resume' | 'archive';
	  };

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
			readonly error: MaintenanceGatewayFailure;
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

export const MaintenancePlanStore = signalStore(
	withState<{
		outcome: MaintenancePlanOutcome;
		components: MaintenanceComponent[];
	}>({ outcome: idleOutcome(), components: [] }),
	withProps(() => ({
		gateway: inject(MaintenanceGateway),
		nextOperationId: { value: 0 },
	})),
	withComputed((store) => {
		const serviceRecords = computed(() =>
			store.gateway.services.hasValue() ? store.gateway.services.value() : [],
		);
		const failures = computed(() =>
			[
				store.gateway.cars.error(),
				store.gateway.timezone.error(),
				store.gateway.plans.error(),
			].map((error) => store.gateway.failure(error)),
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
			plans: computed(() =>
				store.gateway.plans.hasValue() ? store.gateway.plans.value().plans : [],
			),
			activity: computed(() => {
				const activity = store.gateway.plans.hasValue()
					? store.gateway.plans.value().activity
					: [];
				if (activity.length) return activity;
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
			loading: computed(() =>
				[store.gateway.cars, store.gateway.timezone, store.gateway.plans].some(
					(resource) => resource.isLoading(),
				),
			),
			error: computed(() => resourceMessage(failures())),
			action: computed(() => {
				const outcome = store.outcome();
				if (outcome.status !== 'pending') return null;
				const command = outcome.command;
				return command.kind === 'save-plan'
					? command.mode
					: `${command.action}:${command.planId}`;
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
								outcome: { status: 'failed', operationId, command, error },
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
				store.gateway.cars.reload();
				store.gateway.timezone.reload();
				store.gateway.plans.reload();
			},
			refresh(): void {
				store.gateway.plans.reload();
			},
			clearOutcome(): void {
				patchState(store, { outcome: idleOutcome() });
			},
			mutate(command: MaintenancePlanCommand): void {
				if (store.outcome().status !== 'pending') mutate(command);
			},
			loadComponents(carId: string): void {
				loadComponents(carId);
			},
		};
	}),
);
