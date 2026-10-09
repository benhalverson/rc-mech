import { InjectionToken, Injector, inject, Service } from '@angular/core';
import { OfflineCapabilities } from '../offline/offline-capabilities';

export const loadSignOutRecovery = () => import('./sign-out-recovery-action');
export const SIGN_OUT_RECOVERY_LOADER = new InjectionToken<
	typeof loadSignOutRecovery
>('SIGN_OUT_RECOVERY_LOADER', { factory: () => loadSignOutRecovery });

/**
 * Lightweight public-entry bootstrap for deferred sign-out. App creates it before
 * the authenticated shell exists; it loads the recovery action lazily only when
 * storage is available, keeping private workspace code out of the initial bundle.
 */
@Service()
export class SignOutRecovery {
	private readonly injector = inject(Injector);
	private readonly capabilities = inject(OfflineCapabilities);
	private readonly load = inject(SIGN_OUT_RECOVERY_LOADER);
	constructor() {
		if (this.capabilities.storageAvailable) void this.restore();
	}
	private async restore(): Promise<void> {
		try {
			await (await this.load()).resumePendingSignOut(this.injector);
		} catch {
			/* Preserve pending cleanup if storage or its lazy shell is unavailable. */
		}
	}
}
