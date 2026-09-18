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
			clipsResource: inject(CornerReviewGateway).readClips(store.analysisId),
			lifecycleResource: inject(AnalysisLifecycleGateway).read(
				store.analysisId,
			),
			lifecycleGateway: inject(AnalysisLifecycleGateway),
			requestIdentity: inject(DrivingAnalysisRequestIdentityCapability),
		};
	}),
	withComputed((store) => ({
		lifecycleReadError: computed(() =>
			store.lifecycleResource.error()
				? 'Analysis controls could not be loaded. Refresh evidence to try again.'
				: null,
		),
		lifecycle: computed(() =>
			store.lifecycleResource.hasValue()
				? store.lifecycleResource.value()
				: null,
		),
	})),
	withComputed((store) => ({
		review: computed(() => {
			const status = store.lifecycle()?.status;
			if (status === 'deleting' || status === 'deleted') return null;
			if (!store.resource.hasValue()) return null;
			const review = store.resource.value();
			const clips = store.clipsResource.hasValue()
				? store.clipsResource.value()
				: [];
			return {
				...review,
				corners: review.corners.map((corner) => ({
					...corner,
					passes: corner.passes.map((pass) => ({
						...pass,
						clip:
							clips.find(
								(clip) =>
									clip.cornerId === corner.id &&
									clip.segmentId === pass.provenance.segmentId &&
									clip.ordinal === pass.ordinal,
							) ?? null,
					})),
				})),
			};
		}),
		clipsError: computed(() =>
			store.clipsResource.error()
				? 'Clips could not be loaded. Refresh evidence to try again.'
				: null,
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
							store.clipsResource.reload();
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
				const identity = {
					analysisId: current.analysisId,
					expectedStateVersion: current.stateVersion,
				};
				execute(
					command.action === 'retry'
						? {
								...identity,
								action: 'retry',
								commandId: store.requestIdentity.retryId(
									current.analysisId,
									current.stateVersion,
								),
							}
						: { ...identity, action: command.action },
				);
			},
			selectAnalysis(command: Readonly<{ analysisId: string }>): void {
				patchState(store, command);
			},
			refresh(): void {
				store.resource.reload();
				store.clipsResource.reload();
				store.lifecycleResource.reload();
			},
		};
	}),
);
