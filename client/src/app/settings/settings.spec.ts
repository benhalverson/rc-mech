import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
	type TestRequest,
} from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Settings } from './settings';
import { SettingsStore } from './settings-store';
import { TimezoneGateway } from './timezone-gateway';
import { TimezoneStore } from './timezone-store';

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
				SettingsStore,
				TimezoneGateway,
				TimezoneStore,
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
		TestBed.inject(TimezoneStore).refresh();
	});

	it('renders an invite read error and retries that resource', async () => {
		http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 'UTC' });
		http
			.expectOne('/api/v1/invite-codes')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		http.expectOne('/api/auth/passkey/list-user-passkeys').flush([]);
		await fixture.whenStable();
		fixture.detectChanges();
		const inviteInput = fixture.nativeElement.querySelector(
			'#new-invite-code',
		) as HTMLInputElement;
		inviteInput.value = 'TRACK-DAY-02';
		inviteInput.dispatchEvent(new Event('input'));
		fixture.detectChanges();

		expect(fixture.nativeElement.textContent).toContain(
			'Invite codes could not be loaded',
		);
		expect(fixture.nativeElement.textContent).not.toContain('5 of 5 remaining');
		expect(inviteInput.parentElement?.querySelector('button')?.disabled).toBe(
			true,
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
		fixture.detectChanges();
		expect(input.parentElement?.textContent).toContain('Saving…');
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

	it('announces a failed passkey registration as an alert', async () => {
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
		fixture.detectChanges();
		expect(input.parentElement?.textContent).toContain('Waiting…');
		http
			.expectOne(
				(request) =>
					request.url === '/api/auth/passkey/generate-register-options' &&
					request.params.get('name') === 'Track phone',
			)
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		await fixture.whenStable();
		fixture.detectChanges();

		const message =
			'The passkey request could not be completed. Try again or use a magic link.';
		expect(
			[...fixture.nativeElement.querySelectorAll('[role="alert"]')].some(
				(element: HTMLElement) => element.textContent?.includes(message),
			),
		).toBe(true);
		expect(
			[...fixture.nativeElement.querySelectorAll('[role="status"]')].some(
				(element: HTMLElement) => element.textContent?.includes(message),
			),
		).toBe(false);
	});

	it('explains when the browser returns no passkey credential', async () => {
		flushInitialReads();
		createCredential.mockResolvedValue(null);
		await fixture.whenStable();
		fixture.detectChanges();
		const input = fixture.nativeElement.querySelector(
			'#passkey-name',
		) as HTMLInputElement;
		input.value = 'Track phone';
		input.dispatchEvent(new Event('input'));
		fixture.detectChanges();
		input.closest('form')?.dispatchEvent(new Event('submit'));
		http
			.expectOne(
				(request) =>
					request.url === '/api/auth/passkey/generate-register-options' &&
					request.params.get('name') === 'Track phone',
			)
			.flush({ challenge: 'AQID' });
		await fixture.whenStable();
		fixture.detectChanges();

		expect(fixture.nativeElement.textContent).toContain(
			'No passkey was returned by the browser.',
		);
		http.expectNone('/api/auth/passkey/verify-registration');
	});

	it('rejects overlong passkey names at the store mutation boundary', async () => {
		flushInitialReads();
		await fixture.whenStable();
		const store = TestBed.inject(SettingsStore);
		const overlong = 'x'.repeat(81);

		expect(await store.registerPasskey(overlong)).toBe(false);
		expect(await store.renamePasskey(store.passkeys()[0], overlong)).toBe(
			false,
		);
		expect(store.passkeyActionError()).toContain('80 characters or fewer');
		expect(createCredential).not.toHaveBeenCalled();
		http.expectNone('/api/auth/passkey/update-passkey');
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
		fixture.detectChanges();
		expect(input.parentElement?.textContent).toContain('Creating…');

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
		await fixture.whenStable();
		fixture.detectChanges();
		expect(input.value).toBe('');
		expect(input.getAttribute('aria-describedby')).toBeNull();
		expect(fixture.nativeElement.textContent).not.toContain(
			'Enter an invite code.',
		);
	});

	it('rejects an invalid invite code at the store mutation boundary', async () => {
		flushInitialReads();
		await fixture.whenStable();
		const store = TestBed.inject(SettingsStore);

		expect(await store.createInviteCode('bad code!')).toBe(false);
		expect(store.inviteActionError()).toContain(
			'only letters, numbers, or hyphens',
		);
		http.expectNone('/api/v1/invite-codes');
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
		expect(fixture.nativeElement.textContent).toContain('OWNER-01');

		await store.copyInviteCode('OWNER-01');
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Copied OWNER-01.');
		expect(fixture.nativeElement.textContent).not.toContain(
			'The invite code could not be copied.',
		);
	});

	it('resets rename validation between passkey edit sessions', async () => {
		flushInitialReads();
		await fixture.whenStable();
		fixture.detectChanges();
		const rename = [...fixture.nativeElement.querySelectorAll('button')].find(
			(button: HTMLButtonElement) => button.textContent?.trim() === 'Rename',
		) as HTMLButtonElement;
		rename.click();
		fixture.detectChanges();
		let input = fixture.nativeElement.querySelector(
			'#rename-passkey-1',
		) as HTMLInputElement;
		input.value = '';
		input.dispatchEvent(new Event('input'));
		input.closest('form')?.dispatchEvent(new Event('submit'));
		fixture.detectChanges();
		expect(input.getAttribute('aria-describedby')).toBe(
			'rename-validation-passkey-1',
		);

		const cancel = [...fixture.nativeElement.querySelectorAll('button')].find(
			(button: HTMLButtonElement) => button.textContent?.trim() === 'Cancel',
		) as HTMLButtonElement;
		cancel.click();
		fixture.detectChanges();
		(
			[...fixture.nativeElement.querySelectorAll('button')].find(
				(button: HTMLButtonElement) => button.textContent?.trim() === 'Rename',
			) as HTMLButtonElement
		).click();
		fixture.detectChanges();
		input = fixture.nativeElement.querySelector(
			'#rename-passkey-1',
		) as HTMLInputElement;
		expect(input.value).toBe('Workshop laptop');
		expect(input.getAttribute('aria-describedby')).toBeNull();
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
		await fixture.whenStable();
		fixture.detectChanges();
		expect(input.value).toBe('');
		expect(input.getAttribute('aria-describedby')).toBeNull();
		expect(fixture.nativeElement.textContent).not.toContain(
			'Name this passkey.',
		);
	});

	it('renders empty states, non-revocable invites, and retries passkey reads', async () => {
		http.expectOne('/api/v1/preferences/timezone').flush({});
		http.expectOne('/api/v1/invite-codes').flush({
			allowance: 5,
			used: 1,
			remaining: 4,
			codes: [
				{
					id: 'invite-used',
					code: 'USED-01',
					status: 'redeemed',
					createdAt: '2026-08-07T00:00:00.000Z',
				},
			],
		});
		http
			.expectOne('/api/auth/passkey/list-user-passkeys')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		await fixture.whenStable();
		fixture.detectChanges();

		expect(fixture.nativeElement.textContent).toContain('USED-01');
		expect(fixture.nativeElement.textContent).not.toContain('Revoke');
		expect(fixture.nativeElement.textContent).toContain(
			'Passkeys could not be loaded',
		);
		const retry = [...fixture.nativeElement.querySelectorAll('button')].find(
			(button: HTMLButtonElement) =>
				button.textContent?.trim() === 'Try again' &&
				button.previousElementSibling?.textContent?.includes('Passkeys'),
		) as HTMLButtonElement;
		retry.click();
		let refresh: TestRequest | undefined;
		await vi.waitFor(() => {
			refresh = http.expectOne('/api/auth/passkey/list-user-passkeys');
		});
		refresh?.flush([]);
		await fixture.whenStable();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('No passkeys yet');
	});

	it('marks each settings form invalid before it can mutate', async () => {
		flushInitialReads();
		await fixture.whenStable();
		fixture.detectChanges();

		for (const selector of [
			'#garage-timezone',
			'#new-invite-code',
			'#passkey-name',
		]) {
			const input = fixture.nativeElement.querySelector(
				selector,
			) as HTMLInputElement;
			input.value = '';
			input.dispatchEvent(new Event('input'));
			input.closest('form')?.dispatchEvent(new Event('submit'));
		}
		await fixture.whenStable();
		fixture.detectChanges();

		expect(fixture.nativeElement.textContent).toContain('Enter a timezone');
		expect(fixture.nativeElement.textContent).toContain('Enter an invite code');
		expect(fixture.nativeElement.textContent).toContain('Name this passkey');
		http.expectNone('/api/v1/preferences/timezone');
		http.expectNone('/api/v1/invite-codes');
		http.expectNone('/api/auth/passkey/generate-register-options');
	});

	it('rejects invalid and concurrent timezone saves and surfaces API detail', async () => {
		flushInitialReads();
		await fixture.whenStable();
		const store = TestBed.inject(TimezoneStore);

		store.saveTimezone({ timezone: 'Not/A_Timezone' });
		expect(store.error()).toContain('valid IANA timezone');

		store.saveTimezone({ timezone: ' UTC ' });
		store.saveTimezone({ timezone: 'America/New_York' });
		http
			.expectOne('/api/v1/preferences/timezone')
			.flush(
				{ error: 'That timezone is disabled.' },
				{ status: 422, statusText: 'Unprocessable Content' },
			);
		expect(store.error()).toBe('The timezone setting could not be loaded.');

		store.saveTimezone({ timezone: 'UTC' });
		http
			.expectOne('/api/v1/preferences/timezone')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		expect(store.error()).toContain('could not be loaded');
	});

	it('blocks unavailable invite creation and handles create and revoke failures', async () => {
		const store = TestBed.inject(SettingsStore);
		expect(await store.createInviteCode('EARLY-01')).toBe(false);
		http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 'UTC' });
		http.expectOne('/api/v1/invite-codes').flush({
			allowance: 5,
			used: 5,
			remaining: 0,
			codes: [],
		});
		http.expectOne('/api/auth/passkey/list-user-passkeys').flush([]);
		await fixture.whenStable();
		fixture.detectChanges();
		const input = fixture.nativeElement.querySelector(
			'#new-invite-code',
		) as HTMLInputElement;
		input.value = 'FINAL-01';
		input.dispatchEvent(new Event('input'));
		input.closest('form')?.dispatchEvent(new Event('submit'));
		await fixture.whenStable();
		expect(input.value).toBe('FINAL-01');
		http.expectNone('/api/v1/invite-codes');
	});

	it('serializes invite mutations and supports their failure paths', async () => {
		flushInitialReads();
		await fixture.whenStable();
		const store = TestBed.inject(SettingsStore);

		const create = store.createInviteCode('TRACK-03');
		expect(await store.createInviteCode('TRACK-04')).toBe(false);
		http
			.expectOne('/api/v1/invite-codes')
			.flush(
				{ error: 'That invite code already exists.' },
				{ status: 409, statusText: 'Conflict' },
			);
		expect(await create).toBe(false);
		expect(store.inviteActionError()).toContain('already exists');

		const usedCode = { ...store.inviteCodes()[0], status: 'redeemed' };
		await store.revokeInviteCode(usedCode);
		http.expectNone(`/api/v1/invite-codes/${usedCode.id}/revoke`);

		const available = store.inviteCodes()[0];
		const revoke = store.revokeInviteCode(available);
		await store.revokeInviteCode(available);
		http
			.expectOne(`/api/v1/invite-codes/${available.id}/revoke`)
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		await revoke;
		expect(store.inviteActionError()).toContain('could not be revoked');
	});

	it('handles empty, malformed, and concurrent passkey registration', async () => {
		flushInitialReads();
		await fixture.whenStable();
		const store = TestBed.inject(SettingsStore);
		expect(await store.registerPasskey('')).toBe(false);

		createCredential.mockResolvedValue({});
		const malformed = store.registerPasskey('Track tablet');
		http
			.expectOne(
				(request) =>
					request.url === '/api/auth/passkey/generate-register-options',
			)
			.flush({ challenge: 'AQ' });
		expect(await malformed).toBe(false);
		expect(store.passkeyActionError()).toContain(
			'No passkey was returned by the browser',
		);

		const pending = store.registerPasskey('Track tablet');
		expect(await store.registerPasskey('Track phone')).toBe(false);
		http
			.expectOne(
				(request) =>
					request.url === '/api/auth/passkey/generate-register-options',
			)
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		expect(await pending).toBe(false);
	});

	it('renames and revokes passkeys while serializing actions', async () => {
		flushInitialReads();
		await fixture.whenStable();
		const store = TestBed.inject(SettingsStore);
		const passkey = store.passkeys()[0];
		expect(await store.renamePasskey(passkey, '')).toBe(false);

		const rename = store.renamePasskey(passkey, ' Track laptop ');
		expect(await store.renamePasskey(passkey, 'Other name')).toBe(false);
		const renameRequest = http.expectOne('/api/auth/passkey/update-passkey');
		expect(renameRequest.request.body).toEqual({
			id: 'passkey-1',
			name: 'Track laptop',
		});
		renameRequest.flush({ status: true });
		let refresh: TestRequest | undefined;
		await vi.waitFor(() => {
			refresh = http.expectOne('/api/auth/passkey/list-user-passkeys');
		});
		refresh?.flush([passkey]);
		expect(await rename).toBe(true);

		const revoke = store.revokePasskey(passkey);
		await store.revokePasskey(passkey);
		http
			.expectOne('/api/auth/passkey/delete-passkey')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		await revoke;
		expect(store.passkeyActionError()).toContain('could not be completed');
	});

	it('drives invite and passkey row actions through their rendered controls', async () => {
		writeClipboardText.mockResolvedValue(undefined);
		flushInitialReads();
		await fixture.whenStable();
		fixture.detectChanges();

		const button = (label: string): HTMLButtonElement => {
			const match = [...fixture.nativeElement.querySelectorAll('button')].find(
				(candidate: HTMLButtonElement) =>
					candidate.textContent?.trim() === label,
			) as HTMLButtonElement | undefined;
			if (!match) throw new Error(`${label} button was not rendered.`);
			return match;
		};

		button('Copy').click();
		await vi.waitFor(() =>
			expect(writeClipboardText).toHaveBeenCalledWith('OWNER-01'),
		);

		button('Rename').click();
		fixture.detectChanges();
		const renameInput = fixture.nativeElement.querySelector(
			'#rename-passkey-1',
		) as HTMLInputElement;
		renameInput.value = 'Pit laptop';
		renameInput.dispatchEvent(new Event('input'));
		renameInput.closest('form')?.dispatchEvent(new Event('submit'));
		const rename = http.expectOne('/api/auth/passkey/update-passkey');
		rename.flush({ status: true });
		let passkeyRefresh: TestRequest | undefined;
		await vi.waitFor(() => {
			passkeyRefresh = http.expectOne('/api/auth/passkey/list-user-passkeys');
		});
		passkeyRefresh?.flush([]);
		await fixture.whenStable();
		fixture.detectChanges();

		button('Revoke').click();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Revoking…');
		http
			.expectOne('/api/v1/invite-codes/invite-1/revoke')
			.flush({ status: true });
		let inviteRefresh: TestRequest | undefined;
		await vi.waitFor(() => {
			inviteRefresh = http.expectOne('/api/v1/invite-codes');
		});
		inviteRefresh?.flush({ allowance: 5, used: 2, remaining: 3, codes: [] });
	});

	it('renders unnamed passkeys and preserves rename editing after a failed save', async () => {
		http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 'UTC' });
		http.expectOne('/api/v1/invite-codes').flush({
			allowance: 5,
			used: 0,
			remaining: 5,
			codes: [],
		});
		http
			.expectOne('/api/auth/passkey/list-user-passkeys')
			.flush([{ id: 'passkey-unnamed', name: null }]);
		await fixture.whenStable();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Unnamed passkey');
		expect(fixture.nativeElement.textContent).toContain('Added recently');

		const button = (label: string): HTMLButtonElement =>
			[...fixture.nativeElement.querySelectorAll('button')].find(
				(candidate: HTMLButtonElement) =>
					candidate.textContent?.trim() === label,
			) as HTMLButtonElement;
		button('Rename').click();
		fixture.detectChanges();
		const renameInput = fixture.nativeElement.querySelector(
			'#rename-passkey-unnamed',
		) as HTMLInputElement;
		expect(renameInput.value).toBe('Passkey');
		renameInput.value = 'Backup key';
		renameInput.dispatchEvent(new Event('input'));
		renameInput.closest('form')?.dispatchEvent(new Event('submit'));
		http
			.expectOne('/api/auth/passkey/update-passkey')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		await fixture.whenStable();
		fixture.detectChanges();
		expect(
			fixture.nativeElement.querySelector('#rename-passkey-unnamed'),
		).toBeTruthy();

		button('Cancel').click();
		fixture.detectChanges();
		button('Revoke').click();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Revoking…');
		http.expectOne('/api/auth/passkey/delete-passkey').flush({ status: true });
		let refresh: TestRequest | undefined;
		await vi.waitFor(() => {
			refresh = http.expectOne('/api/auth/passkey/list-user-passkeys');
		});
		refresh?.flush([]);
	});

	it('retries a failed timezone read from its rendered control', async () => {
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
		const retry = [...fixture.nativeElement.querySelectorAll('button')].find(
			(button: HTMLButtonElement) =>
				button.textContent?.trim() === 'Try again' &&
				button.previousElementSibling?.textContent?.includes('timezone'),
		) as HTMLButtonElement;
		retry.click();
		let refresh: TestRequest | undefined;
		await vi.waitFor(() => {
			refresh = http.expectOne('/api/v1/preferences/timezone');
		});
		refresh?.flush({ timezone: 'UTC' });
	});
});
