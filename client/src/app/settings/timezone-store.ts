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
import { catchError, exhaustMap, of, tap } from 'rxjs';
import {
	defaultTimezone,
	isValidTimezone,
	type TimezonePreference,
} from './settings.models';
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
	message: string;
	outcome: TimezoneSaveOutcome;
};

const initialState: TimezoneState = {
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
	})),
	withComputed((store) => ({
		timezone: computed(() => {
			const preference: TimezonePreference | undefined =
				store.gateway.preference.hasValue()
					? store.gateway.preference.value()
					: undefined;
			return preference?.timezone && isValidTimezone(preference.timezone)
				? preference.timezone
				: defaultTimezone();
		}),
		loading: computed(() => store.gateway.preference.isLoading()),
		error: computed(() => {
			const outcome = store.outcome();
			return outcome.status === 'failed'
				? outcome.error.message
				: store.gateway.preference.error()
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
);
