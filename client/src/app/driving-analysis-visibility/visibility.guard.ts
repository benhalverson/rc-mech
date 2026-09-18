import { inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { type CanMatchFn, Router } from '@angular/router';
import { filter, map, take } from 'rxjs';
import { VisibilityStore } from './visibility-store';

export const drivingAnalysisCanMatch = (() => {
	const visibility = inject(VisibilityStore);
	const router = inject(Router);
	return toObservable(visibility.resolution).pipe(
		filter(() => !visibility.pending()),
		take(1),
		map(() => visibility.visible() || router.createUrlTree(['/garage'])),
	);
}) satisfies CanMatchFn;
