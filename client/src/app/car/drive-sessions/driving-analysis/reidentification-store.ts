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
import { catchError, EMPTY, exhaustMap, tap } from 'rxjs';
import type {
	CorrectionReceipt,
	ReidentifySubjectCommand,
} from './reidentification.models';
import { ReidentificationGateway } from './reidentification-gateway';
import { ReidentificationIdentity } from './reidentification-identity';

type Outcome = Readonly<{
	status: 'idle' | 'pending' | 'succeeded' | 'failed';
	correctionId: string | null;
	receipt: CorrectionReceipt | null;
}>;
const idle = (): Outcome => ({
	status: 'idle',
	correctionId: null,
	receipt: null,
});

export const ReidentificationStore = signalStore(
	withState({ analysisId: '', selectionVersion: 0, outcome: idle() }),
	withProps(() => ({
		gateway: inject(ReidentificationGateway),
		identities: inject(ReidentificationIdentity),
	})),
	withProps((store) => ({
		remote: store.gateway.read(
			computed(() => ({
				analysisId: store.analysisId(),
				version: store.selectionVersion(),
			})),
		),
	})),
	withComputed((store) => ({
		context: computed(() =>
			store.remote.hasValue() ? store.remote.value() : null,
		),
		loading: computed(() => store.remote.isLoading()),
		readFailed: computed(() => !!store.remote.error()),
	})),
	withMethods((store) => {
		const correct = rxMethod<ReidentifySubjectCommand>((commands) =>
			commands.pipe(
				exhaustMap((command) => {
					if (
						command.analysisId !== store.analysisId() ||
						command.context.segmentId !== store.context()?.segmentId
					)
						return EMPTY;
					const correctionId =
						command.context.pendingCorrection?.correctionId ??
						store.identities.forCommand(command);
					const selectionVersion = store.selectionVersion();
					patchState(store, {
						outcome: { status: 'pending', correctionId, receipt: null },
					});
					return store.gateway.correct(command, correctionId).pipe(
						tap((receipt) => {
							if (
								store.analysisId() === command.analysisId &&
								store.selectionVersion() === selectionVersion
							)
								patchState(store, {
									outcome: { status: 'succeeded', correctionId, receipt },
								});
						}),
						catchError(() => {
							if (
								store.analysisId() === command.analysisId &&
								store.selectionVersion() === selectionVersion
							)
								patchState(store, {
									outcome: { status: 'failed', correctionId, receipt: null },
								});
							return EMPTY;
						}),
					);
				}),
			),
		);
		return {
			retryContext(): void {
				store.remote.reload();
			},
			select(analysisId: string, selectionVersion = 0): void {
				if (
					analysisId === store.analysisId() &&
					selectionVersion === store.selectionVersion()
				)
					return;
				patchState(store, { analysisId, selectionVersion, outcome: idle() });
			},
			correct(command: ReidentifySubjectCommand): void {
				correct(command);
			},
		};
	}),
);
