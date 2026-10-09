import { Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { OfflineCapabilities } from '../offline/offline-capabilities';
import { OfflineGarageStorage } from '../offline/offline-garage-storage';
import {
	loadSignOutRecovery,
	SIGN_OUT_RECOVERY_LOADER,
	SignOutRecovery,
} from './sign-out-recovery';
import { resumePendingSignOut } from './sign-out-recovery-action';
import { SignOutStore } from './sign-out-store';

afterEach(() => TestBed.resetTestingModule());
it('loads durable cleanup lazily and starts private recovery only for a pending request', async () => {
	const pendingSignOut = vi.fn(async (): Promise<unknown> => null);
	const restorePendingSignOut = vi.fn(async () => {});
	TestBed.configureTestingModule({
		providers: [
			{ provide: OfflineCapabilities, useValue: { storageAvailable: true } },
			{ provide: OfflineGarageStorage, useValue: { pendingSignOut } },
			{ provide: SignOutStore, useValue: { restorePendingSignOut } },
		],
	});
	expect(TestBed.inject(SIGN_OUT_RECOVERY_LOADER)).toBe(loadSignOutRecovery);
	expect((await loadSignOutRecovery()).resumePendingSignOut).toBe(
		resumePendingSignOut,
	);
	TestBed.inject(SignOutRecovery);
	await vi.waitFor(() => expect(pendingSignOut).toHaveBeenCalled());
	expect(restorePendingSignOut).not.toHaveBeenCalled();
	pendingSignOut.mockResolvedValue({
		operationId: 'pending',
		sessionKey: 'old',
	});
	await resumePendingSignOut(TestBed.inject(Injector));
	expect(restorePendingSignOut).toHaveBeenCalledOnce();
});
it.each([false, true])(
	'preserves cleanup when capability availability is %s and loading fails',
	async (storageAvailable) => {
		const load = vi.fn(async () => {
			throw new Error('unavailable');
		});
		TestBed.configureTestingModule({
			providers: [
				{ provide: OfflineCapabilities, useValue: { storageAvailable } },
				{ provide: SIGN_OUT_RECOVERY_LOADER, useValue: load },
			],
		});
		TestBed.inject(SignOutRecovery);
		await Promise.resolve();
		await Promise.resolve();
		expect(load).toHaveBeenCalledTimes(storageAvailable ? 1 : 0);
	},
);
