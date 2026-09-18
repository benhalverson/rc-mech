import {
	computed,
	effect,
	Injector,
	inject,
	runInInjectionContext,
	untracked,
} from '@angular/core';
import {
	patchState,
	signalStore,
	withComputed,
	withHooks,
	withProps,
	withState,
} from '@ngrx/signals';
import { OwnerSessionStore } from '../owner-session-store';
import { VisibilityGateway } from './visibility-gateway';

type Snapshot = {
	key: string | null;
	owner: boolean;
	enabled: boolean;
	setting: boolean | null;
	settled: boolean;
};
const empty: Snapshot = {
	key: null,
	owner: false,
	enabled: false,
	setting: null,
	settled: false,
};

export type VisibilityResolution =
	| { status: 'idle'; operationId: null }
	| { status: 'pending' | 'failed'; operationId: string }
	| { status: 'succeeded'; operationId: string; visible: boolean };

// Application-wide session context shared by navigation and independent workflows.
export const VisibilityStore = signalStore(
	{ providedIn: 'root' },
	withState(empty),
	withProps(() => ({
		_session: inject(OwnerSessionStore),
		_gateway: inject(VisibilityGateway),
		_injector: inject(Injector),
	})),
	withComputed((store) => ({
		isOwner: computed(
			() =>
				!!store._session.sessionKey() &&
				store.key() === store._session.sessionKey() &&
				store.owner(),
		),
		resolution: computed<VisibilityResolution>(() => {
			const operationId = store._session.sessionKey();
			if (!operationId) return { status: 'idle', operationId: null };
			if (store.key() !== operationId || (!store.settled() && !store.owner()))
				return { status: 'pending', operationId };
			if (!store.owner() && store.setting() === null)
				return { status: 'failed', operationId };
			return {
				status: 'succeeded',
				operationId,
				visible: store.owner() || store.enabled(),
			};
		}),
	})),
	withComputed((store) => ({
		visible: computed(() => {
			const resolution = store.resolution();
			return resolution.status === 'succeeded' && resolution.visible;
		}),
		pending: computed(() => store.resolution().status === 'pending'),
	})),
	withHooks((store) => ({
		onInit() {
			effect(
				(onCleanup) => {
					const key = store._session.sessionKey();
					patchState(store, { ...empty, key });
					if (!key) return;
					const reads = untracked(() =>
						runInInjectionContext(store._injector, () => store._gateway.read()),
					);
					const observer = untracked(() =>
						effect(
							() => {
								patchState(store, {
									key,
									owner: reads.owner.hasValue() && reads.owner.value().isOwner,
									enabled: reads.flag.hasValue() && reads.flag.value().enabled,
									setting: reads.flag.hasValue()
										? reads.flag.value().enabled
										: null,
									settled: !reads.owner.isLoading() && !reads.flag.isLoading(),
								});
							},
							{ injector: store._injector },
						),
					);
					onCleanup(() => {
						observer.destroy();
						reads.owner.destroy();
						reads.flag.destroy();
					});
				},
				{ injector: store._injector },
			);
		},
	})),
);
