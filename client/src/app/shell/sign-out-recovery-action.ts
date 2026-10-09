import type { Injector } from '@angular/core';
import { OfflineGarageStorage } from '../offline/offline-garage-storage';

export const resumePendingSignOut = async (
	injector: Injector,
): Promise<void> => {
	if (await injector.get(OfflineGarageStorage).pendingSignOut()) {
		const { SignOutStore } = await import('./sign-out-store');
		await injector.get(SignOutStore).restorePendingSignOut();
	}
};
