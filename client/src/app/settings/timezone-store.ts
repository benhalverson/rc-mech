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
import { catchError, EMPTY, exhaustMap, of, tap } from 'rxjs';
import { OFFLINE_OPERATION_ID } from '../offline/offline-garage-storage';
import {
	defaultTimezone,
	isValidTimezone,
	type TimezonePreference,
} from './settings.models';
import { SettingsWorkspaceStore } from './settings-workspace-store';
import {
	TimezoneGateway,
	type TimezoneGatewayFailure,
} from './timezone-gateway';

export type SaveTimezoneCommand = { readonly timezone: string };
export type TimezoneSaveOutcome =
	| { status: 'idle'; operation: 'save-timezone'; operationId: null }
	| { status: 'pending'; operation: 'save-timezone'; operationId: number }
	| {
			status: 'succeeded';
			operation: 'save-timezone';
			operationId: number;
			timezone: string;
	  }
	| {
			status: 'failed';
			operation: 'save-timezone';
			operationId: number;
			error: TimezoneGatewayFailure;
	  };

type TimezoneState = {
	localRequestId: string | null;
	message: string;
	outcome: TimezoneSaveOutcome;
};

const initialState: TimezoneState = {
	localRequestId: null,
	message: '',
	outcome: { status: 'idle', operation: 'save-timezone', operationId: null },
};

const readFailure = (): string =>
	'The timezone setting could not be loaded. Dates are shown in your browser timezone.';

export const TimezoneStore = signalStore(
	withState(initialState),
	withProps(() => ({
		gateway: inject(TimezoneGateway),
		nextOperationId: { value: 0 },
		workspace: inject(SettingsWorkspaceStore),
		nextLocalId: inject(OFFLINE_OPERATION_ID),
	})),
	withComputed((store) => ({
		timezone: computed(() => {
			const local = store.workspace.current();
			if (local) return local.timezone;
			const preference: TimezonePreference | undefined =
				store.gateway.preference.hasValue()
					? store.gateway.preference.value()
					: undefined;
			return preference?.timezone && isValidTimezone(preference.timezone)
				? preference.timezone
				: defaultTimezone();
		}),
		loading: computed(
			() => !store.workspace.current() && store.gateway.preference.isLoading(),
		),
		error: computed(() => {
			const syncError = store.workspace
				.operations()
				.find(
					(operation) =>
						operation.command.type === 'timezone' &&
						operation.status !== 'pending',
				);
			if (syncError)
				return `${syncError.status === 'conflict' ? 'Sync conflict' : 'Needs attention'}: ${syncError.feedback} ${syncError.remote ? 'Remote timezone: ' + syncError.remote : ''}`;
			const outcome = store.outcome();
			return outcome.status === 'failed'
				? outcome.error.message
				: !store.workspace.current() && store.gateway.preference.error()
					? readFailure()
					: '';
		}),
		saving: computed(() => store.outcome().status === 'pending'),
	})),
	withMethods((store) => {
		const save = rxMethod<SaveTimezoneCommand>((commands$) =>
			commands$.pipe(
				exhaustMap((command) => {
					const timezone = command.timezone.trim();
					const operationId = ++store.nextOperationId.value;
					if (!isValidTimezone(timezone)) {
						patchState(store, {
							outcome: {
								status: 'failed',
								operation: 'save-timezone',
								operationId,
								error: {
									kind: 'rejected-response',
									message:
										'Use a valid IANA timezone, such as America/Los_Angeles.',
								},
							},
						});
						return of(null);
					}
					patchState(store, {
						message: '',
						outcome: {
							status: 'pending',
							operation: 'save-timezone',
							operationId,
						},
					});
					if (store.workspace.available()) {
						const requestId = store.nextLocalId();
						patchState(store, { localRequestId: requestId });
						store.workspace.mutate({
							requestId,
							change: { type: 'timezone', base: store.timezone(), timezone },
						});
						return EMPTY;
					}
					return store.gateway.saveTimezone({ timezone }).pipe(
						tap(() => store.gateway.refresh()),
						tap(() =>
							patchState(store, {
								message: `Dates will now use ${timezone}.`,
								outcome: {
									status: 'succeeded',
									operation: 'save-timezone',
									operationId,
									timezone,
								},
							}),
						),
						catchError((error: TimezoneGatewayFailure) => {
							patchState(store, {
								outcome: {
									status: 'failed',
									operation: 'save-timezone',
									operationId,
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
			saveTimezone(command: SaveTimezoneCommand): void {
				save(command);
			},
			retry(): void {
				patchState(store, {
					outcome: {
						status: 'idle',
						operation: 'save-timezone',
						operationId: null,
					},
				});
				store.gateway.refresh();
			},
			refresh(): void {
				store.gateway.refresh();
			},
		};
	}),
	withHooks((store) => ({
		onInit() {
			effect(() => {
				const result = store.workspace.outcome();
				const current = store.outcome();
				if (
					result.requestId !== store.localRequestId() ||
					current.status !== 'pending'
				)
					return;
				if (result.status === 'succeeded')
					patchState(store, {
						localRequestId: null,
						message: 'Saved on this device.',
						outcome: {
							status: 'succeeded',
							operation: 'save-timezone',
							operationId: current.operationId,
							timezone: store.timezone(),
						},
					});
				else if (result.status === 'failed')
					patchState(store, {
						localRequestId: null,
						outcome: {
							status: 'failed',
							operation: 'save-timezone',
							operationId: current.operationId,
							error: { kind: 'unavailable', message: result.message },
						},
					});
			});
		},
	})),
);
