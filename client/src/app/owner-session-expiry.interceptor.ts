import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { OwnerSessionStore } from './owner-session-store';

const protectedApiPrefix = '/api/v1/';

export const ownerSessionExpiryInterceptor: HttpInterceptorFn = (
	request,
	next,
) => {
	const router = inject(Router);
	const sessionStore = inject(OwnerSessionStore);

	return next(request).pipe(
		catchError((error: unknown) => {
			if (
				error instanceof HttpErrorResponse &&
				error.status === 401 &&
				request.url.startsWith(protectedApiPrefix)
			) {
				const returnTo = router.url.startsWith('/') ? router.url : '/garage';
				sessionStore.expire();
				void router.navigate(['/sign-in'], {
					queryParams: { returnTo, reason: 'session-expired' },
				});
			}
			return throwError(() => error);
		}),
	);
};
