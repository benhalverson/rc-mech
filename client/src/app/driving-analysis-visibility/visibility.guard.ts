import { effect, Injector, inject, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { type CanMatchFn, Router } from '@angular/router';
import { Observable, take } from 'rxjs';
import { VisibilityStore } from './visibility-store';

/** Waits for current-session visibility with a subscription-owned signal watcher. */
export const drivingAnalysisCanMatch = (() => {
	const visibility = inject(VisibilityStore);
	const router = inject(Router);
	const injector = inject(Injector);
	return new Observable<boolean | ReturnType<Router['createUrlTree']>>(
		(subscriber) => {
			const watcher = effect(
				() => {
					visibility.resolution();
					if (visibility.pending()) return;
					untracked(() =>
						subscriber.next(
							visibility.visible() || router.createUrlTree(['/garage']),
						),
					);
				},
				{ injector, manualCleanup: true },
			);
			return () => watcher.destroy();
		},
	).pipe(take(1), takeUntilDestroyed());
}) satisfies CanMatchFn;
