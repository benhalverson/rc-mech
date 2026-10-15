import { computed, inject } from '@angular/core';
import {
	patchState,
	signalStore,
	withComputed,
	withMethods,
	withProps,
	withState,
} from '@ngrx/signals';
import {
	AnalysisHistoryGateway,
	type HistorySelection,
} from './analysis-history-gateway';

export const AnalysisHistoryStore = signalStore(
	withState<HistorySelection>({ carId: '', driveSessionId: '', cursor: null }),
	withProps((store) => ({
		remote: inject(AnalysisHistoryGateway).read(
			computed(() => ({
				carId: store.carId(),
				driveSessionId: store.driveSessionId(),
				cursor: store.cursor(),
			})),
		),
	})),
	withComputed((store) => ({
		analyses: computed(() =>
			store.remote.hasValue() ? store.remote.value().drivingAnalyses : [],
		),
		nextCursor: computed(() =>
			store.remote.hasValue() ? store.remote.value().nextCursor : null,
		),
		loading: computed(() => store.remote.isLoading()),
		failed: computed(() => !!store.remote.error()),
	})),
	withMethods((store) => ({
		select(command: Readonly<{ carId: string; driveSessionId: string }>): void {
			if (
				command.carId === store.carId() &&
				command.driveSessionId === store.driveSessionId()
			)
				return;
			patchState(store, { ...command, cursor: null });
		},
		older(): void {
			const cursor = store.nextCursor();
			if (cursor && !store.loading()) patchState(store, { cursor });
		},
		newest(): void {
			patchState(store, { cursor: null });
		},
		reload(): void {
			store.remote.reload();
		},
	})),
);
