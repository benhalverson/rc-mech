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
import { CornerReviewGateway } from './corner-review-gateway';

export const CornerReviewStore = signalStore(
	withState({ analysisId: '' }),
	withProps((store) => {
		return {
			resource: inject(CornerReviewGateway).read(store.analysisId),
			clipsResource: inject(CornerReviewGateway).readClips(store.analysisId),
		};
	}),
	withComputed((store) => ({
		review: computed(() => {
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
	withMethods((store) => ({
		selectAnalysis(command: Readonly<{ analysisId: string }>): void {
			patchState(store, command);
		},
		refresh(): void {
			store.resource.reload();
			store.clipsResource.reload();
		},
	})),
);
