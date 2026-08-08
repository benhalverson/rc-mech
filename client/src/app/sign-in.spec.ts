import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
	TestRequest,
} from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { ActivatedRoute, provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OwnerSessionStore } from './owner-session-store';
import { SignIn } from './sign-in';

class FakePublicKeyCredential {
	readonly id = 'passkey-1';
	readonly rawId = Uint8Array.from([1, 2, 3]).buffer;
	readonly type = 'public-key';
	readonly response = {
		clientDataJSON: Uint8Array.from([4]).buffer,
		authenticatorData: Uint8Array.from([5]).buffer,
		signature: Uint8Array.from([6]).buffer,
		userHandle: null as ArrayBuffer | null,
	};

	getClientExtensionResults(): AuthenticationExtensionsClientOutputs {
		return {};
	}
}

describe('SignIn', () => {
	let fixture: ComponentFixture<SignIn>;
	let http: HttpTestingController;
	let routeParameters: Record<string, string>;
	const getCredential = vi.fn();
	const credentialsDescriptor = Object.getOwnPropertyDescriptor(
		navigator,
		'credentials',
	);

	beforeEach(async () => {
		routeParameters = { returnTo: '/garage/car-42/photos' };
		vi.stubGlobal('PublicKeyCredential', FakePublicKeyCredential);
		getCredential.mockReset();
		Object.defineProperty(navigator, 'credentials', {
			configurable: true,
			value: { get: getCredential },
		});
		await TestBed.configureTestingModule({
			imports: [SignIn],
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				provideNoopAnimations(),
				provideRouter([]),
				OwnerSessionStore,
				{
					provide: ActivatedRoute,
					useValue: {
						snapshot: {
							queryParamMap: {
								get: (name: string) => routeParameters[name] ?? null,
								has: (name: string) => name in routeParameters,
							},
						},
					},
				},
			],
		}).compileComponents();
		http = TestBed.inject(HttpTestingController);
		fixture = TestBed.createComponent(SignIn);
		fixture.detectChanges();
		http.expectOne('/api/auth/get-session').flush(null);
	});

	afterEach(() => {
		http.verify();
		vi.unstubAllGlobals();
		if (credentialsDescriptor)
			Object.defineProperty(navigator, 'credentials', credentialsDescriptor);
		else Reflect.deleteProperty(navigator, 'credentials');
	});

	it('preserves the requested destination in a magic-link callback', () => {
		const email = fixture.nativeElement.querySelector(
			'#owner-email',
		) as HTMLInputElement;
		email.value = 'owner@example.test';
		email.dispatchEvent(new Event('input'));
		email.closest('form')?.dispatchEvent(new Event('submit'));

		const request = http.expectOne('/api/auth/sign-in/magic-link');
		expect(request.request.body.email).toBe('owner@example.test');
		expect(new URL(request.request.body.callbackURL).pathname).toBe(
			'/garage/car-42/photos',
		);
		expect(new URL(request.request.body.callbackURL).search).toBe('');
		fixture.detectChanges();
		expect(email.disabled).toBe(true);
		request.flush({});
	});

	it('returns to the requested deep link after passkey authentication', async () => {
		getCredential.mockResolvedValue(new FakePublicKeyCredential());
		const router = TestBed.inject(Router);
		const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);

		const button = fixture.nativeElement.querySelector(
			'.passkey-button',
		) as HTMLButtonElement;
		expect(button.disabled).toBe(false);
		button.click();

		http
			.expectOne('/api/auth/passkey/generate-authenticate-options')
			.flush({ challenge: 'AQ' });
		let verificationRequest: TestRequest | undefined;
		await vi.waitFor(() => {
			verificationRequest = http.expectOne(
				'/api/auth/passkey/verify-authentication',
			);
		});
		verificationRequest?.flush({ status: true });
		fixture.detectChanges();
		let sessionRequest: TestRequest | undefined;
		await vi.waitFor(() => {
			sessionRequest = http.expectOne('/api/auth/get-session');
		});
		sessionRequest?.flush({
			session: { id: 'session-2' },
			user: { email: 'owner@example.test' },
		});
		await fixture.whenStable();

		expect(navigate).toHaveBeenCalledWith('/garage/car-42/photos');
	});

	it('renders the public owner access form', () => {
		expect(
			fixture.nativeElement.querySelector('main[tabindex="-1"]'),
		).toBeTruthy();
		expect(
			fixture.nativeElement.querySelector('input[type="email"]'),
		).toBeTruthy();
		expect(fixture.nativeElement.querySelector('[type="submit"]')).toBeTruthy();
	});

	it('toggles registration and posts a normalized invite request', () => {
		const toggle = [...fixture.nativeElement.querySelectorAll('button')].find(
			(button: HTMLButtonElement) => button.textContent?.includes('Register'),
		) as HTMLButtonElement;
		toggle.click();
		fixture.detectChanges();
		const email = fixture.nativeElement.querySelector(
			'#owner-email',
		) as HTMLInputElement;
		const invite = fixture.nativeElement.querySelector(
			'#invite-code',
		) as HTMLInputElement;
		expect(invite).toBeTruthy();
		email.value = ' User@Example.Test ';
		email.dispatchEvent(new Event('input'));
		invite.value = ' track-01 ';
		invite.dispatchEvent(new Event('input'));
		invite.closest('form')?.dispatchEvent(new Event('submit'));
		const request = http.expectOne('/api/auth/register');
		expect(request.request.body).toMatchObject({
			email: 'User@Example.Test',
			inviteCode: 'track-01',
		});
		fixture.detectChanges();
		expect(email.disabled).toBe(true);
		expect(invite.disabled).toBe(true);
		request.flush({ status: true });
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'registration link is on its way',
		);
	});

	it('shows a neutral registration error without exposing invite validity', () => {
		const toggle = [...fixture.nativeElement.querySelectorAll('button')].find(
			(button: HTMLButtonElement) => button.textContent?.includes('Register'),
		) as HTMLButtonElement;
		toggle.click();
		fixture.detectChanges();
		const email = fixture.nativeElement.querySelector(
			'#owner-email',
		) as HTMLInputElement;
		const invite = fixture.nativeElement.querySelector(
			'#invite-code',
		) as HTMLInputElement;
		email.value = 'user@example.test';
		email.dispatchEvent(new Event('input'));
		invite.value = 'TRACK-01';
		invite.dispatchEvent(new Event('input'));
		invite.closest('form')?.dispatchEvent(new Event('submit'));
		http
			.expectOne('/api/auth/register')
			.flush({}, { status: 503, statusText: 'Unavailable' });
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'could not be completed',
		);
	});

	it('focuses invalid sign-in and registration fields without sending', () => {
		const email = fixture.nativeElement.querySelector(
			'#owner-email',
		) as HTMLInputElement;
		email.closest('form')?.dispatchEvent(new Event('submit'));
		fixture.detectChanges();
		expect(email.getAttribute('aria-describedby')).toBe('email-validation');
		http.expectNone('/api/auth/sign-in/magic-link');

		const toggle = [...fixture.nativeElement.querySelectorAll('button')].find(
			(button: HTMLButtonElement) => button.textContent?.includes('Register'),
		) as HTMLButtonElement;
		toggle.click();
		fixture.detectChanges();
		email.closest('form')?.dispatchEvent(new Event('submit'));
		fixture.detectChanges();
		expect(document.activeElement).toBe(email);

		email.value = 'user@example.test';
		email.dispatchEvent(new Event('input'));
		const invite = fixture.nativeElement.querySelector(
			'#invite-code',
		) as HTMLInputElement;
		invite.value = 'x'.repeat(33);
		invite.dispatchEvent(new Event('input'));
		invite.closest('form')?.dispatchEvent(new Event('submit'));
		fixture.detectChanges();
		expect(invite.getAttribute('aria-describedby')).toBe(
			'invite-code-validation',
		);
		expect(fixture.nativeElement.textContent).toContain(
			'32 characters or fewer',
		);

		invite.value = 'bad code';
		invite.dispatchEvent(new Event('input'));
		invite.closest('form')?.dispatchEvent(new Event('submit'));
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'only letters, numbers, or hyphens',
		);
		http.expectNone('/api/auth/register');
	});

	it('uses generic retry guidance for magic-link failures and rate limits', () => {
		const email = fixture.nativeElement.querySelector(
			'#owner-email',
		) as HTMLInputElement;
		email.value = 'owner@example.test';
		email.dispatchEvent(new Event('input'));
		email.closest('form')?.dispatchEvent(new Event('submit'));
		http
			.expectOne('/api/auth/sign-in/magic-link')
			.flush({}, { status: 429, statusText: 'Too Many Requests' });
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Too many requests');

		email.closest('form')?.dispatchEvent(new Event('submit'));
		http
			.expectOne('/api/auth/sign-in/magic-link')
			.flush({}, { status: 503, statusText: 'Unavailable' });
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Check the address and try again',
		);
	});

	it('uses generic retry guidance for registration rate limits', () => {
		const toggle = [...fixture.nativeElement.querySelectorAll('button')].find(
			(button: HTMLButtonElement) => button.textContent?.includes('Register'),
		) as HTMLButtonElement;
		toggle.click();
		fixture.detectChanges();
		const email = fixture.nativeElement.querySelector(
			'#owner-email',
		) as HTMLInputElement;
		const invite = fixture.nativeElement.querySelector(
			'#invite-code',
		) as HTMLInputElement;
		email.value = 'user@example.test';
		email.dispatchEvent(new Event('input'));
		invite.value = 'TRACK-01';
		invite.dispatchEvent(new Event('input'));
		invite.closest('form')?.dispatchEvent(new Event('submit'));
		http
			.expectOne('/api/auth/register')
			.flush({}, { status: 429, statusText: 'Too Many Requests' });
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Too many requests');
	});

	it('handles cancelled, missing, and concurrent passkey ceremonies', async () => {
		const button = fixture.nativeElement.querySelector(
			'.passkey-button',
		) as HTMLButtonElement;
		getCredential.mockRejectedValueOnce(
			new DOMException('cancelled', 'NotAllowedError'),
		);
		button.click();
		button.click();
		http
			.expectOne('/api/auth/passkey/generate-authenticate-options')
			.flush({ challenge: 'AQ' });
		await fixture.whenStable();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'cancelled or timed out',
		);

		getCredential.mockResolvedValueOnce(null);
		button.click();
		http
			.expectOne('/api/auth/passkey/generate-authenticate-options')
			.flush({ challenge: 'AQ' });
		await fixture.whenStable();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'passkey request could not be completed',
		);
		http.expectNone('/api/auth/passkey/verify-authentication');
	});

	it('converts allow-list credentials and an assertion user handle', async () => {
		const credential = new FakePublicKeyCredential();
		credential.response.userHandle = Uint8Array.from([251, 255]).buffer;
		getCredential.mockResolvedValue(credential);
		vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
		(
			fixture.nativeElement.querySelector(
				'.passkey-button',
			) as HTMLButtonElement
		).click();
		http.expectOne('/api/auth/passkey/generate-authenticate-options').flush({
			challenge: 'AQ',
			allowCredentials: [
				{ id: '-_8', type: 'public-key', transports: ['internal'] },
			],
		});
		let verification: TestRequest | undefined;
		await vi.waitFor(() => {
			verification = http.expectOne('/api/auth/passkey/verify-authentication');
		});
		expect(getCredential).toHaveBeenCalledWith({
			publicKey: expect.objectContaining({
				allowCredentials: [
					expect.objectContaining({ id: Uint8Array.from([251, 255]) }),
				],
			}),
		});
		expect(verification?.request.body.response.response.userHandle).toBe('-_8');
		verification?.flush({ status: true });
		let sessionRequest: TestRequest | undefined;
		await vi.waitFor(() => {
			sessionRequest = http.expectOne('/api/auth/get-session');
		});
		sessionRequest?.flush({ session: { id: 'session-3' } });
		await fixture.whenStable();
	});

	it('normalizes unsafe return paths and describes callback failures', () => {
		const internal = fixture.componentInstance as unknown as {
			initialMessage(): string;
			readonly returnTo: string;
		};
		routeParameters = { reason: 'session-expired' };
		expect(internal.initialMessage()).toContain('session has expired');
		expect(internal.returnTo).toBe('/garage');

		routeParameters = { error_description: 'expired', returnTo: '//evil.test' };
		expect(internal.initialMessage()).toContain(
			'recovery link could not be used',
		);
		expect(internal.returnTo).toBe('/garage');

		routeParameters = { returnTo: 'https://evil.test' };
		expect(internal.initialMessage()).toBe('');
		expect(internal.returnTo).toBe('/garage');
	});

	it('can initialize when browser globals are absent', () => {
		const browserWindow = window;
		vi.stubGlobal('window', undefined);
		try {
			const signIn = TestBed.runInInjectionContext(() => new SignIn());
			expect(signIn).toBeInstanceOf(SignIn);
		} finally {
			vi.stubGlobal('window', browserWindow);
		}
	});
});
