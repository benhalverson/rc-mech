import { computed, inject } from '@angular/core';
import {
	signalStore,
	withComputed,
	withMethods,
	withProps,
} from '@ngrx/signals';
import { CurrentSetupGateway } from './current-setup-gateway';
import {
	changesFromPreviousSetup,
	currentSetupPriorityRows,
	currentSetupRemainingRows,
} from './current-setup.rules';

export type CurrentSetupFailure = {
	readonly message: string;
	readonly retryable: boolean;
};

export const CurrentSetupStore = signalStore(
	withProps(() => ({ gateway: inject(CurrentSetupGateway) })),
	withComputed((store) => {
		const setups = computed(() =>
			store.gateway.collection.hasValue()
				? store.gateway.collection.value().setups
				: [],
		);
		const current = computed(() => {
			if (!store.gateway.collection.hasValue()) return null;
			const collection = store.gateway.collection.value();
			return (
				collection.setups.find(
					(setup) => setup.id === collection.currentSetupId,
				) ??
				collection.setups.find((setup) => setup.current) ??
				null
			);
		});
		return {
			setups,
			current,
			loading: computed(() => store.gateway.collection.isLoading()),
			failure: computed<CurrentSetupFailure | null>(() => {
				const failure = store.gateway.failure();
				if (!failure) return null;
				if (failure.kind === 'http' && failure.status === 401)
					return {
						message:
							'Your garage session has expired. Sign in again to continue.',
						retryable: false,
					};
				if (failure.kind === 'http' && failure.status === 404)
					return {
						message: 'The current setup is unavailable for this car.',
						retryable: false,
					};
				return {
					message:
						'The current setup could not be loaded. Check the connection and try again.',
					retryable: true,
				};
			}),
			priorityRows: computed(() => {
				const setup = current();
				return setup ? currentSetupPriorityRows(setup) : [];
			}),
			remainingRows: computed(() => {
				const setup = current();
				return setup ? currentSetupRemainingRows(setup) : [];
			}),
			changes: computed(() => {
				const setup = current();
				return setup ? changesFromPreviousSetup(setup, setups()) : [];
			}),
		};
	}),
	withMethods((store) => ({
		retry(): void {
			store.gateway.refresh();
		},
	})),
);
