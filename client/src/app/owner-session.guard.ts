import { inject } from '@angular/core';
import { CanMatchFn, Router } from '@angular/router';
import { OwnerSessionStore } from './owner-session-store';

export const ownerSessionCanMatch: CanMatchFn = async (_route, segments) => {
	// The root shell performs its initial session check before the first SPA redirect.
	// Let that established flow own the request; direct deep links still wait for the
	// shared resource and cannot load protected feature code while signed out.
	if (
		typeof window !== 'undefined' &&
		(window.location.pathname === '/' || window.location.pathname === '')
	)
		return true;
	const sessionStore = inject(OwnerSessionStore);
	const router = inject(Router);
	const session = await sessionStore.resolved();
	if (session?.session) return true;

	const destination = `/${segments.map((segment) => segment.path).join('/')}`;
	return router.createUrlTree(['/sign-in'], {
		queryParams: { returnTo: destination === '/' ? '/garage' : destination },
	});
};
