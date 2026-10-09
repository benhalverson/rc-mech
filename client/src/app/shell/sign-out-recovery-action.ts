import type { Injector } from '@angular/core';
import { OfflineGarageStorage } from '../offline/offline-garage-storage';

/**
 * Checks durable cleanup after the lightweight public bootstrap loads this module.
 * Imports SignOutStore only when a request exists, preventing an ordinary public
 * visit from eagerly constructing authenticated workspace coordinators.
 */
export const resumePendingSignOut = async (
	injector: Injector,
): Promise<void> => {
	if (await injector.get(OfflineGarageStorage).pendingSignOut()) {
		const { SignOutStore } = await import('./sign-out-store');
		await injector.get(SignOutStore).restorePendingSignOut();
	}
};
