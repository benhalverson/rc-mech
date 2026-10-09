import { inject } from '@angular/core';
import { CanMatchFn, Router } from '@angular/router';
import { offlineOwnerFromSession } from './offline/offline-owner';
import { canOpenOfflineRoute } from './offline/offline-route-access';
import { OfflineWorkspaceAccess } from './offline/offline-workspace-access';
import { OfflineWorkspaceStore } from './offline/offline-workspace-store';
import { OwnerSessionStore } from './owner-session-store';

/**
 * Admits protected routes from a verified online session or an eligible retained
 * offline session. Uses the delivered-route allowlist so cached authentication
 * cannot promise workflows whose data/capabilities are unavailable offline.
 */
export const ownerSessionCanMatch: CanMatchFn = async (_route, segments) => {
	const sessionStore = inject(OwnerSessionStore);
	const router = inject(Router);
	const offlineAccess = inject(OfflineWorkspaceAccess);
	const offlineWorkspace = inject(OfflineWorkspaceStore);
	const offlineAdmission = () =>
		canOpenOfflineRoute(segments.map((segment) => segment.path)) ||
		router.createUrlTree(['/offline-unavailable']);
	const session = await sessionStore.resolved();
	if (session?.session) {
		if (offlineWorkspace.networkUnavailable()) return offlineAdmission();
		const owner = offlineOwnerFromSession(session);
		if (owner && !offlineWorkspace.hasSnapshotFor(owner))
			offlineWorkspace.prepare({ owner });
		return true;
	}
	if (sessionStore.resolutionFailed()) {
		try {
			const snapshot = await offlineAccess.restore();
			if (snapshot) {
				offlineWorkspace.openOffline({ snapshot });
				return offlineAdmission();
			}
		} catch {
			// A failed local read must fall back to the normal signed-out boundary.
		}
	}

	const destination =
		router.getCurrentNavigation()?.extractedUrl.toString() ??
		`/${segments.map((segment) => segment.path).join('/')}`;
	return router.createUrlTree(['/sign-in'], {
		queryParams: { returnTo: destination === '/' ? '/garage' : destination },
	});
};
