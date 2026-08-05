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
});
