import { computed, inject } from '@angular/core';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import {
	patchState,
	signalStore,
	withComputed,
	withMethods,
	withProps,
	withState,
} from '@ngrx/signals';
import { catchError, exhaustMap, of, tap } from 'rxjs';
import { CarBuildGateway } from './car-build-gateway';
import { carReadFailure } from './car-read-failure';
import type {
	BuildGatewayFailure,
	BuildSaveOutcome,
	InstalledComponent,
	SaveBuildCommand,
} from './car.models';

const installationTime = (component: InstalledComponent): number => {
	const timestamp = component.installedAt
		? Date.parse(component.installedAt)
		: Number.NaN;
	return Number.isNaN(timestamp) ? 0 : timestamp;
};

const idleOutcome = (): BuildSaveOutcome => ({
	status: 'idle',
	operationId: null,
});

export const CarBuildStore = signalStore(
	withState({ carId: '', outcome: idleOutcome() }),
	withProps(() => ({
		gateway: inject(CarBuildGateway),
		nextOperationId: { value: 0 },
	})),
	withComputed((store) => {
		const components = computed(() =>
			store.gateway.collection.hasValue()
				? store.gateway.collection.value().components
				: [],
		);
		return {
			components,
			failure: computed(() => {
				const failure = store.gateway.failure();
				return carReadFailure(
					failure?.kind === 'http' ? { status: failure.status } : failure,
					'The build sheet could not be loaded.',
				);
			}),
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
			loading: computed(() => store.gateway.collection.isLoading()),
			action: computed(() => {
				const outcome = store.outcome();
				return outcome.status === 'pending' ? outcome.mode : null;
			}),
			error: computed(() => {
				const outcome = store.outcome();
				if (outcome.status !== 'failed') return '';
				return outcome.error.kind === 'http' && outcome.error.status === 401
					? 'Your garage session has expired. Sign in again to continue.'
					: outcome.error.kind === 'http' && outcome.error.status === 409
						? 'Restore this car before changing its build.'
						: 'The component could not be saved.';
			}),
			message: computed(() => {
				const outcome = store.outcome();
				return outcome.status === 'succeeded'
					? outcome.mode === 'replace'
						? 'Component replaced; previous installation retained.'
						: 'Build sheet saved.'
					: '';
			}),
		};
	}),
	withMethods((store) => {
		const save = rxMethod<SaveBuildCommand>((commands$) =>
			commands$.pipe(
				exhaustMap((command) => {
					const operationId = ++store.nextOperationId.value;
					patchState(store, {
						outcome: {
							status: 'pending',
							operationId,
							mode: command.mode,
						},
					});
					return store.gateway.save(command).pipe(
						tap(() => {
							if (store.carId() !== command.carId) return;
							store.gateway.refresh();
							patchState(store, {
								outcome: {
									status: 'succeeded',
									operationId,
									mode: command.mode,
								},
							});
						}),
						catchError((error: BuildGatewayFailure) => {
							if (store.carId() === command.carId)
								patchState(store, {
									outcome: {
										status: 'failed',
										operationId,
										mode: command.mode,
										error,
									},
								});
							return of(null);
						}),
					);
				}),
			),
		);
		return {
			selectCar(carId: string): void {
				if (store.carId() === carId) return;
				patchState(store, { carId, outcome: idleOutcome() });
				store.gateway.selectCar(carId);
			},
			retry(): void {
				store.gateway.refresh();
			},
			refresh(): void {
				store.gateway.refresh();
			},
			clearOutcome(): void {
				patchState(store, { outcome: idleOutcome() });
			},
			save(command: Omit<SaveBuildCommand, 'carId'>): void {
				const carId = store.carId();
				if (!carId || store.outcome().status === 'pending') return;
				save({ ...command, carId });
			},
		};
	}),
);
