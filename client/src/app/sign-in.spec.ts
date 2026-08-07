import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
	TestRequest,
} from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import {
	ActivatedRoute,
	convertToParamMap,
	provideRouter,
	Router,
} from '@angular/router';
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
		userHandle: null,
	};

	getClientExtensionResults(): AuthenticationExtensionsClientOutputs {
		return {};
	}
}

describe('SignIn', () => {
	let fixture: ComponentFixture<SignIn>;
	let http: HttpTestingController;
	const getCredential = vi.fn();
	const credentialsDescriptor = Object.getOwnPropertyDescriptor(
		navigator,
		'credentials',
	);

	beforeEach(async () => {
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
							queryParamMap: convertToParamMap({
								returnTo: '/garage/car-42/photos',
							}),
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
		const component = fixture.componentInstance as unknown as {
			email: { set(value: string): void };
			requestMagicLink(): void;
		};
		component.email.set('owner@example.test');
		component.requestMagicLink();

		const request = http.expectOne('/api/auth/sign-in/magic-link');
		expect(request.request.body.email).toBe('owner@example.test');
		expect(new URL(request.request.body.callbackURL).pathname).toBe(
			'/garage/car-42/photos',
		);
		expect(new URL(request.request.body.callbackURL).search).toBe('');
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
		await new Promise<void>((resolve) => setTimeout(resolve));
		http
			.expectOne('/api/auth/passkey/verify-authentication')
			.flush({ status: true });
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
		const component = fixture.componentInstance as unknown as {
			email: { set(value: string): void };
			inviteCode: { set(value: string): void };
			toggleRegistration(): void;
			register(): void;
		};
		component.toggleRegistration();
		fixture.detectChanges();
		const invite = fixture.nativeElement.querySelector(
			'#invite-code',
		) as HTMLInputElement;
		expect(invite).toBeTruthy();
		expect(invite.required).toBe(true);
		component.email.set(' User@Example.Test ');
		component.inviteCode.set(' track-01 ');
		component.register();
		const request = http.expectOne('/api/auth/register');
		expect(request.request.body).toMatchObject({
			email: 'User@Example.Test',
			inviteCode: 'track-01',
		});
		request.flush({ status: true });
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'registration link is on its way',
		);
	});

	it('shows a neutral registration error without exposing invite validity', () => {
		const component = fixture.componentInstance as unknown as {
			email: { set(value: string): void };
			inviteCode: { set(value: string): void };
			toggleRegistration(): void;
			register(): void;
		};
		component.toggleRegistration();
		component.email.set('user@example.test');
		component.inviteCode.set('TRACK-01');
		component.register();
		http
			.expectOne('/api/auth/register')
			.flush({}, { status: 503, statusText: 'Unavailable' });
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'could not be completed',
		);
	});
});
