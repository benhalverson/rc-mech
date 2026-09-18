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
		};
	}),
	withComputed((store) => ({
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
	withMethods((store) => ({
		selectAnalysis(command: Readonly<{ analysisId: string }>): void {
			patchState(store, command);
		},
		refresh(): void {
			store.resource.reload();
		},
	})),
);
