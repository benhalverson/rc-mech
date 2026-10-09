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
import { catchError, exhaustMap, of, tap } from 'rxjs';
import { CarWorkspaceStore } from '../garage/car-sync/car-workspace-store';
import type { BuildSyncCommand } from './build-sync/build-sync.models';
import type {
	BuildGatewayFailure,
	BuildSaveOutcome,
	InstalledComponent,
	SaveBuildCommand,
} from './car.models';
import { CarBuildGateway } from './car-build-gateway';
import { carReadFailure } from './car-read-failure';

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
	withState({
		carId: '',
		outcome: idleOutcome(),
		localCommand: null as BuildSyncCommand | null,
		localOperationId: '',
	}),
	withProps(() => ({
		gateway: inject(CarBuildGateway),
		workspace: inject(CarWorkspaceStore),
		nextOperationId: { value: 0 },
	})),
	withComputed((store) => {
		const localCollection = computed(() =>
			store.workspace.opened()
				? store.workspace
						.buildCollections()
						.find((collection) => collection.carId === store.carId())
				: undefined,
		);
		const components = computed(
			() =>
				localCollection()?.components ??
				(store.gateway.collection.hasValue()
					? store.gateway.collection.value().components
					: []),
		);
		return {
			components,
			failure: computed(() => {
				if (localCollection()) return null;
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
			loading: computed(
				() => !localCollection() && store.gateway.collection.isLoading(),
			),
			syncOperations: computed(() =>
				store.workspace
					.buildOperations()
					.filter((operation) => operation.carId === store.carId()),
			),
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
				if (
					outcome.status === 'succeeded' &&
					store.workspace
						.buildOperations()
						.some(
							(operation) => operation.operationId === store.localOperationId(),
						)
				)
					return 'Build change saved on this device. Pending sync.';
				return outcome.status === 'succeeded'
					? outcome.mode === 'remove'
						? 'Component removed; installation history retained.'
						: outcome.mode === 'replace'
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
				patchState(store, {
					carId,
					outcome: idleOutcome(),
					localCommand: null,
					localOperationId: '',
				});
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
				if (store.workspace.durableSetupMutationsAvailable()) {
					const localCommand: BuildSyncCommand = {
						action: command.mode === 'add' ? 'install' : command.mode,
						carId,
						componentId: command.componentId,
						input: command.input,
					};
					patchState(store, {
						localCommand,
						localOperationId: '',
						outcome: {
							status: 'pending',
							operationId: ++store.nextOperationId.value,
							mode: command.mode,
						},
					});
					store.workspace.commitBuild(localCommand);
				} else save({ ...command, carId });
			},
		};
	}),
	withHooks({
		onInit(store) {
			effect(() => {
				const collection = store.gateway.collection.hasValue()
					? store.gateway.collection.value()
					: undefined;
				if (collection?.carId && collection.version !== undefined)
					store.workspace.observeServerBuildCollection({
						carId: collection.carId,
						version: collection.version,
						components: collection.components,
					});
			});
			effect(() => {
				const result = store.workspace.buildMutationOutcome();
				const pending = store.outcome();
				if (
					pending.status !== 'pending' ||
					result.status === 'idle' ||
					result.command !== store.localCommand()
				)
					return;
				if (result.status === 'succeeded')
					patchState(store, {
						localOperationId: result.operationId,
						outcome: {
							status: 'succeeded',
							operationId: pending.operationId,
							mode: pending.mode,
						},
					});
				else if (result.status === 'failed')
					patchState(store, {
						outcome: {
							status: 'failed',
							operationId: pending.operationId,
							mode: pending.mode,
							error: { kind: 'unavailable' },
						},
					});
			});
		},
	}),
);
