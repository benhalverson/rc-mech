import { inject } from '@angular/core';
import { CanMatchFn, Router } from '@angular/router';
import { OwnerSessionStore } from './owner-session-store';

export const ownerSessionCanMatch: CanMatchFn = async (_route, segments) => {
	const sessionStore = inject(OwnerSessionStore);
	const router = inject(Router);
	const session = await sessionStore.resolved();
	if (session?.session) return true;

	const destination =
		router.getCurrentNavigation()?.extractedUrl.toString() ??
		`/${segments.map((segment) => segment.path).join('/')}`;
	return router.createUrlTree(['/sign-in'], {
		queryParams: { returnTo: destination === '/' ? '/garage' : destination },
	});
};
