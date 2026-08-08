import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsStore } from './settings-store';

describe('SettingsStore computed defaults', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		TestBed.resetTestingModule();
	});

	it('uses unloaded resource defaults and recognizes loopback WebAuthn', async () => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				SettingsStore,
			],
		});
		const store = TestBed.inject(SettingsStore);
		const http = TestBed.inject(HttpTestingController);

		expect(store.inviteCodes()).toEqual([]);
		expect(store.inviteAllowance()).toEqual({
			allowance: 5,
			used: 0,
			remaining: 5,
		});
		expect(store.passkeys()).toEqual([]);

		const browserWindow = window;
		vi.stubGlobal('window', {
			isSecureContext: false,
			location: { hostname: '127.0.0.1' },
			atob: browserWindow.atob.bind(browserWindow),
			btoa: browserWindow.btoa.bind(browserWindow),
		});
		vi.stubGlobal('navigator', { credentials: {} });
		vi.stubGlobal('PublicKeyCredential', class {});
		expect(store.webAuthnAvailable()).toBe(true);
		vi.stubGlobal('window', browserWindow);

		await vi.waitFor(() => {
			http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 'UTC' });
			http.expectOne('/api/v1/invite-codes').flush({
				allowance: 5,
				used: 0,
				remaining: 5,
				codes: [],
			});
			http.expectOne('/api/auth/passkey/list-user-passkeys').flush([]);
		});
		http.verify();
	});
});
