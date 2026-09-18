import { HttpErrorResponse } from '@angular/common/http';
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
import { catchError, EMPTY, exhaustMap, pipe, tap } from 'rxjs';
import {
	type AnalysisLifecycleCommand,
	AnalysisLifecycleGateway,
} from './analysis-lifecycle-gateway';
import { CornerReviewGateway } from './corner-review-gateway';
import { DrivingAnalysisRequestIdentityCapability } from './driving-analysis-request-identity';

export const CornerReviewStore = signalStore(
	withState({
		analysisId: '',
		lifecycleBusy: false,
		lifecycleError: null as string | null,
	}),
	withProps((store) => {
		return {
			resource: inject(CornerReviewGateway).read(store.analysisId),
			lifecycleResource: inject(AnalysisLifecycleGateway).read(
				store.analysisId,
			),
			lifecycleGateway: inject(AnalysisLifecycleGateway),
			requestIdentity: inject(DrivingAnalysisRequestIdentityCapability),
		};
	}),
	withComputed((store) => ({
		lifecycle: computed(() =>
			store.lifecycleResource.hasValue()
				? store.lifecycleResource.value()
				: null,
		),
		review: computed(() =>
			store.resource.hasValue() ? store.resource.value() : null,
		),
		loading: computed(() => store.resource.isLoading()),
		error: computed(() => {
			const error = store.resource.error();
			if (!error) return null;
			if (error instanceof HttpErrorResponse && error.status === 401)
				return 'Your session has expired. Sign in again to review this analysis.';
			if (error instanceof HttpErrorResponse && error.status === 404)
				return 'This Driving analysis is unavailable.';
			return 'Corner evidence could not be loaded. Try again.';
		}),
	})),
	withMethods((store) => {
		const execute = rxMethod<AnalysisLifecycleCommand>(
			pipe(
				exhaustMap((command) => {
					patchState(store, { lifecycleBusy: true, lifecycleError: null });
					return store.lifecycleGateway.mutate(command).pipe(
						tap(() => {
							patchState(store, { lifecycleBusy: false });
							store.lifecycleResource.reload();
							store.resource.reload();
						}),
						catchError(() => {
							patchState(store, {
								lifecycleBusy: false,
								lifecycleError:
									'The action could not be completed. Refresh or try again.',
							});
							return EMPTY;
						}),
					);
				}),
			),
		);
		return {
			changeLifecycle(
				command: Readonly<{ action: AnalysisLifecycleCommand['action'] }>,
			): void {
				const current = store.lifecycle();
				if (!current || store.lifecycleBusy()) return;
				execute({
					action: command.action,
					analysisId: current.analysisId,
					expectedStateVersion: current.stateVersion,
					commandId: store.requestIdentity.retryId(
						current.analysisId,
						current.stateVersion,
					),
				});
			},
			selectAnalysis(command: Readonly<{ analysisId: string }>): void {
				patchState(store, command);
			},
			refresh(): void {
				store.resource.reload();
				store.lifecycleResource.reload();
			},
		};
	}),
);
