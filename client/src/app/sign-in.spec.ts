import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { SignIn } from './sign-in';
import { OwnerSessionStore } from './owner-session-store';

describe('SignIn', () => {
	let fixture: ComponentFixture<SignIn>;
	let http: HttpTestingController;

	beforeEach(async () => {
		await TestBed.configureTestingModule({
			imports: [SignIn],
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				provideNoopAnimations(),
				provideRouter([]),
				OwnerSessionStore,
			],
		}).compileComponents();
		http = TestBed.inject(HttpTestingController);
		fixture = TestBed.createComponent(SignIn);
		fixture.detectChanges();
		http.expectOne('/api/auth/get-session').flush(null);
	});

	afterEach(() => http.verify());

	it('preserves the requested destination in a magic-link callback', () => {
		const component = fixture.componentInstance as unknown as {
			email: { set(value: string): void };
			requestMagicLink(): void;
		};
		component.email.set('owner@example.test');
		component.requestMagicLink();

		const request = http.expectOne('/api/auth/sign-in/magic-link');
		expect(request.request.body.email).toBe('owner@example.test');
		expect(request.request.body.callbackURL).toContain('returnTo=%2Fgarage');
		request.flush({});
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
