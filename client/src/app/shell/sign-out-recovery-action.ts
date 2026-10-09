import type { Injector } from '@angular/core';
import { OfflineGarageStorage } from '../offline/offline-garage-storage';
import { SignOutStore } from './sign-out-store';

export const resumePendingSignOut = async (
	injector: Injector,
): Promise<void> => {
	if (await injector.get(OfflineGarageStorage).pendingSignOut())
		await injector.get(SignOutStore).restorePendingSignOut();
};
