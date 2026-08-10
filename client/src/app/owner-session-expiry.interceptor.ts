import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { EnvironmentInjector, inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, from, switchMap, throwError } from 'rxjs';

const protectedApiPrefix = '/api/v1/';

export const ownerSessionExpiryInterceptor: HttpInterceptorFn = (
	request,
	next,
) => {
	const router = inject(Router);
	const injector = inject(EnvironmentInjector);

	return next(request).pipe(
		catchError((error: unknown) => {
			if (
				error instanceof HttpErrorResponse &&
				error.status === 401 &&
				request.url.startsWith(protectedApiPrefix)
			) {
				return from(import('./owner-session-store')).pipe(
					switchMap(({ OwnerSessionStore }) => {
						const returnTo = router.url.startsWith('/')
							? router.url
							: '/garage';
						injector.get(OwnerSessionStore).expire();
						void router.navigate(['/sign-in'], {
							queryParams: { returnTo, reason: 'session-expired' },
						});
						return throwError(() => error);
					}),
				);
			}
			return throwError(() => error);
		}),
	);
};
