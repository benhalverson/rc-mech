import { computed, inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import {
	patchState,
	signalStore,
	withComputed,
	withMethods,
	withProps,
	withState,
} from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { catchError, EMPTY, filter, switchMap, takeUntil, tap } from 'rxjs';
import { VisibilityStore } from '../../driving-analysis-visibility/visibility-store';
import { OwnerSessionStore } from '../../owner-session-store';
import type { SaveDrivingAnalysisFlagCommand } from './driving-analysis-flag.models';
import { DrivingAnalysisFlagGateway } from './driving-analysis-flag-gateway';

type Outcome =
	| { status: 'idle'; operationId: null }
	| {
			status: 'pending' | 'succeeded' | 'failed';
			operationId: number;
			key: string;
	  };
export const DrivingAnalysisFlagStore = signalStore(
	withState<{
		saved: { key: string; enabled: boolean } | null;
		outcome: Outcome;
	}>({ saved: null, outcome: { status: 'idle', operationId: null } }),
	withProps(() => ({
		_visibility: inject(VisibilityStore),
		_session: inject(OwnerSessionStore),
		_gateway: inject(DrivingAnalysisFlagGateway),
	})),
	withComputed((store) => ({
		isOwner: store._visibility.isOwner,
		enabled: computed(() => {
			if (!store._visibility.isOwner()) return null;
			const saved = store.saved();
			return saved?.key === store._session.sessionKey()
				? saved.enabled
				: store._visibility.setting();
		}),
		status: computed(() => {
			const outcome = store.outcome();
			return outcome.status !== 'idle' &&
				outcome.key === store._session.sessionKey()
				? outcome.status
				: 'idle';
		}),
	})),
	withMethods((store) => {
		let operationId = 0;
		const sessions = toObservable(store._session.sessionKey);
		const save = rxMethod<SaveDrivingAnalysisFlagCommand>((commands) =>
			commands.pipe(
				switchMap((command) => {
					const key = store._session.sessionKey();
					if (!key || !store.isOwner() || store.enabled() === null)
						return EMPTY;
					const id = ++operationId;
					patchState(store, {
						outcome: { status: 'pending', operationId: id, key },
					});
					return store._gateway.save(command).pipe(
						takeUntil(
							sessions.pipe(filter(() => store._session.sessionKey() !== key)),
						),
						tap((response) => {
							if (store._session.sessionKey() !== key) return;
							patchState(store, {
								saved: { key, enabled: response.enabled },
								outcome: { status: 'succeeded', operationId: id, key },
							});
						}),
						catchError(() => {
							if (store._session.sessionKey() === key)
								patchState(store, {
									outcome: { status: 'failed', operationId: id, key },
								});
							return EMPTY;
						}),
					);
				}),
			),
		);
		return {
			save(command: SaveDrivingAnalysisFlagCommand): void {
				if (store.status() === 'pending') return;
				save(command);
			},
		};
	}),
);
