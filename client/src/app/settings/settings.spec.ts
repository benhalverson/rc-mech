import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
	type TestRequest,
} from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Settings } from './settings';
import { SettingsStore } from './settings-store';

class FakeRegistrationCredential {
	readonly id = 'passkey-new';
	readonly rawId = Uint8Array.from([1, 2, 3]).buffer;
	readonly type = 'public-key';
	readonly response = {
		clientDataJSON: Uint8Array.from([4]).buffer,
		attestationObject: Uint8Array.from([5]).buffer,
		getTransports: () => ['internal'] as AuthenticatorTransport[],
	};

	getClientExtensionResults(): AuthenticationExtensionsClientOutputs {
		return {};
	}
}

describe('Settings workspace', () => {
	let fixture: ComponentFixture<Settings>;
	let http: HttpTestingController;
	const createCredential = vi.fn();
	const writeClipboardText = vi.fn();
	const credentialsDescriptor = Object.getOwnPropertyDescriptor(
		navigator,
		'credentials',
	);
	const clipboardDescriptor = Object.getOwnPropertyDescriptor(
		navigator,
		'clipboard',
	);

	beforeEach(async () => {
		vi.stubGlobal('PublicKeyCredential', FakeRegistrationCredential);
		createCredential.mockReset();
		writeClipboardText.mockReset();
		Object.defineProperty(navigator, 'credentials', {
			configurable: true,
			value: { create: createCredential },
		});
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: { writeText: writeClipboardText },
		});
		await TestBed.configureTestingModule({
			imports: [Settings],
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				provideNoopAnimations(),
				SettingsStore,
			],
		}).compileComponents();
		http = TestBed.inject(HttpTestingController);
		fixture = TestBed.createComponent(Settings);
		fixture.detectChanges();
	});

	afterEach(() => {
		http.verify();
		vi.unstubAllGlobals();
		if (credentialsDescriptor)
			Object.defineProperty(navigator, 'credentials', credentialsDescriptor);
		else Reflect.deleteProperty(navigator, 'credentials');
		if (clipboardDescriptor)
			Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
		else Reflect.deleteProperty(navigator, 'clipboard');
	});

	const flushInitialReads = (): void => {
		http
			.expectOne('/api/v1/preferences/timezone')
			.flush({ timezone: 'America/Los_Angeles' });
		http.expectOne('/api/v1/invite-codes').flush({
			allowance: 5,
			used: 1,
			remaining: 4,
			codes: [
				{
					id: 'invite-1',
					code: 'OWNER-01',
					status: 'available',
					createdAt: '2026-08-07T00:00:00.000Z',
				},
			],
		});
		http.expectOne('/api/auth/passkey/list-user-passkeys').flush([
			{
				id: 'passkey-1',
				name: 'Workshop laptop',
				createdAt: '2026-08-07T00:00:00.000Z',
			},
		]);
	};

	it('loads every settings resource on a fresh entry and renders server truth', async () => {
		expect(fixture.nativeElement.textContent).toContain(
			'Loading the garage timezone',
		);
		flushInitialReads();
		await fixture.whenStable();
		fixture.detectChanges();

		expect(fixture.nativeElement.textContent).toContain('OWNER-01');
		expect(fixture.nativeElement.textContent).toContain('4 of 5 remaining');
		expect(fixture.nativeElement.textContent).toContain('Workshop laptop');
		expect(
			fixture.nativeElement.querySelector('[data-route-focus][tabindex="-1"]'),
		).toBeTruthy();
	});

	it('renders an invite read error and retries that resource', async () => {
		http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 'UTC' });
		http
			.expectOne('/api/v1/invite-codes')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		http.expectOne('/api/auth/passkey/list-user-passkeys').flush([]);
		await fixture.whenStable();
		fixture.detectChanges();

		expect(fixture.nativeElement.textContent).toContain(
			'Invite codes could not be loaded',
		);
		const retry = [...fixture.nativeElement.querySelectorAll('button')].find(
			(button: HTMLButtonElement) =>
				button.textContent?.trim() === 'Try again' &&
				button.previousElementSibling?.textContent?.includes('Invite codes'),
		) as HTMLButtonElement | undefined;
		expect(retry).toBeTruthy();
		retry?.click();
		let refresh: TestRequest | undefined;
		await vi.waitFor(() => {
			refresh = http.expectOne('/api/v1/invite-codes');
		});
		refresh?.flush({
			allowance: 5,
			used: 0,
			remaining: 5,
			codes: [],
		});
	});

	it('associates a timezone read error with its input', async () => {
		http
			.expectOne('/api/v1/preferences/timezone')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		http.expectOne('/api/v1/invite-codes').flush({
			allowance: 5,
			used: 0,
			remaining: 5,
			codes: [],
		});
		http.expectOne('/api/auth/passkey/list-user-passkeys').flush([]);
		await fixture.whenStable();
		fixture.detectChanges();

		const input = fixture.nativeElement.querySelector(
			'#garage-timezone',
		) as HTMLInputElement;
		const descriptionId = input.getAttribute('aria-describedby');
		expect(descriptionId).toBe('timezone-validation');
		expect(
			fixture.nativeElement.querySelector(`#${descriptionId}`),
		).toBeTruthy();
	});

	it('validates and saves a timezone before refreshing its read model', async () => {
		flushInitialReads();
		await fixture.whenStable();
		fixture.detectChanges();
		const input = fixture.nativeElement.querySelector(
			'#garage-timezone',
		) as HTMLInputElement;
		input.value = 'America/New_York';
		input.dispatchEvent(new Event('input'));
		fixture.detectChanges();
		input.closest('form')?.dispatchEvent(new Event('submit'));

		const mutation = http.expectOne('/api/v1/preferences/timezone');
		expect(mutation.request.method).toBe('PATCH');
		expect(mutation.request.body).toEqual({ timezone: 'America/New_York' });
		mutation.flush({ timezone: 'America/New_York' });
		let refresh: TestRequest | undefined;
		await vi.waitFor(() => {
			refresh = http.expectOne('/api/v1/preferences/timezone');
		});
		refresh?.flush({ timezone: 'America/New_York' });
		await fixture.whenStable();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Dates will now use America/New_York',
		);
	});

	it('creates an invite code and refreshes the lifetime allowance', async () => {
		flushInitialReads();
		await fixture.whenStable();
		fixture.detectChanges();
		const input = fixture.nativeElement.querySelector(
			'#new-invite-code',
		) as HTMLInputElement;
		input.value = 'TRACK-DAY-02';
		input.dispatchEvent(new Event('input'));
		fixture.detectChanges();
		input.closest('form')?.dispatchEvent(new Event('submit'));

		const mutation = http.expectOne('/api/v1/invite-codes');
		expect(mutation.request.method).toBe('POST');
		expect(mutation.request.body).toEqual({ code: 'TRACK-DAY-02' });
		mutation.flush({ code: { id: 'invite-2', code: 'TRACK-DAY-02' } });
		let refresh: TestRequest | undefined;
		await vi.waitFor(() => {
			refresh = http.expectOne('/api/v1/invite-codes');
		});
		refresh?.flush({
			allowance: 5,
			used: 2,
			remaining: 3,
			codes: [],
		});
	});

	it('clears a stale invite error after copying succeeds', async () => {
		flushInitialReads();
		await fixture.whenStable();
		fixture.detectChanges();
		const store = TestBed.inject(SettingsStore);
		writeClipboardText
			.mockRejectedValueOnce(new Error('Clipboard unavailable'))
			.mockResolvedValueOnce(undefined);

		await store.copyInviteCode('OWNER-01');
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'The invite code could not be copied.',
		);

		await store.copyInviteCode('OWNER-01');
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Copied OWNER-01.');
		expect(fixture.nativeElement.textContent).not.toContain(
			'The invite code could not be copied.',
		);
	});

	it('registers a passkey and refreshes the credential list', async () => {
		createCredential.mockResolvedValue(new FakeRegistrationCredential());
		flushInitialReads();
		await fixture.whenStable();
		fixture.detectChanges();
		const input = fixture.nativeElement.querySelector(
			'#passkey-name',
		) as HTMLInputElement;
		input.value = 'Track phone';
		input.dispatchEvent(new Event('input'));
		fixture.detectChanges();
		input.closest('form')?.dispatchEvent(new Event('submit'));

		const options = http.expectOne(
			(request) =>
				request.url === '/api/auth/passkey/generate-register-options' &&
				request.params.get('name') === 'Track phone',
		);
		options.flush({
			challenge: 'AQ',
			user: { id: 'Ag', name: 'owner', displayName: 'Owner' },
		});
		let verification: TestRequest | undefined;
		await vi.waitFor(() => {
			verification = http.expectOne('/api/auth/passkey/verify-registration');
		});
		expect(verification?.request.body.name).toBe('Track phone');
		verification?.flush({ status: true });
		let refresh: TestRequest | undefined;
		await vi.waitFor(() => {
			refresh = http.expectOne('/api/auth/passkey/list-user-passkeys');
		});
		refresh?.flush([]);
	});
});
