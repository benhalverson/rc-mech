import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthenticationStore } from './authentication-store';
import { SignIn } from './sign-in';

class FakeAuthenticationStore {
	readonly sending = signal(false);
	readonly working = signal(false);
	readonly webAuthnAvailable = signal(true);
	readonly message = signal('');
	readonly sent = signal(false);
	readonly requestMagicLink = vi.fn();
	readonly register = vi.fn();
	readonly authenticateWithPasskey = vi.fn();
	readonly resetFeedback = vi.fn();
}

describe('SignIn', () => {
	let fixture: ComponentFixture<SignIn>;
	let store: FakeAuthenticationStore;

	beforeEach(async () => {
		store = new FakeAuthenticationStore();
		await TestBed.configureTestingModule({
			imports: [SignIn],
			providers: [{ provide: AuthenticationStore, useValue: store }],
		}).compileComponents();
		fixture = TestBed.createComponent(SignIn);
		fixture.detectChanges();
	});

	afterEach(() => TestBed.resetTestingModule());

	const emailInput = (): HTMLInputElement =>
		fixture.nativeElement.querySelector('#owner-email');
	const submitForm = (): void => {
		emailInput().closest('form')?.dispatchEvent(new Event('submit'));
	};
	const registrationToggle = (): HTMLButtonElement =>
		[...fixture.nativeElement.querySelectorAll('button')].find(
			(button: HTMLButtonElement) =>
				button.textContent?.includes('Register') ||
				button.textContent?.includes('Already have'),
		) as HTMLButtonElement;

	it('renders the accessible public owner-access form and status', () => {
		store.message.set('Check your inbox.');
		store.sent.set(true);
		fixture.detectChanges();

		expect(
			fixture.nativeElement.querySelector('main[tabindex="-1"]'),
		).toBeTruthy();
		expect(
			fixture.nativeElement.querySelector('[data-route-focus][tabindex="-1"]'),
		).toBeTruthy();
		expect(fixture.nativeElement.textContent).toContain('Check your inbox.');
		expect(fixture.nativeElement.textContent).toContain(
			'link expires soon and can only be used once',
		);
	});

	it('dispatches one normalized magic-link command', () => {
		const email = emailInput();
		email.value = ' Owner@Example.Test ';
		email.dispatchEvent(new Event('input'));
		submitForm();

		expect(store.requestMagicLink).toHaveBeenCalledWith({
			operation: 'request-magic-link',
			email: 'Owner@Example.Test',
		});
	});

	it('toggles registration, resets feedback, and dispatches a normalized command', () => {
		registrationToggle().click();
		fixture.detectChanges();
		expect(store.resetFeedback).toHaveBeenCalledOnce();

		const email = emailInput();
		const invite = fixture.nativeElement.querySelector(
			'#invite-code',
		) as HTMLInputElement;
		email.value = ' User@Example.Test ';
		email.dispatchEvent(new Event('input'));
		invite.value = ' track-01 ';
		invite.dispatchEvent(new Event('input'));
		submitForm();

		expect(store.register).toHaveBeenCalledWith({
			operation: 'register',
			email: 'User@Example.Test',
			inviteCode: 'track-01',
		});

		registrationToggle().click();
		fixture.detectChanges();
		expect(store.resetFeedback).toHaveBeenCalledTimes(2);
		expect(fixture.nativeElement.querySelector('#invite-code')).toBeNull();
	});

	it('validates and focuses the sign-in email without dispatching', () => {
		submitForm();
		fixture.detectChanges();

		expect(document.activeElement).toBe(emailInput());
		expect(emailInput().getAttribute('aria-describedby')).toBe(
			'email-validation',
		);
		expect(store.requestMagicLink).not.toHaveBeenCalled();

		registrationToggle().click();
		fixture.detectChanges();
		submitForm();
		fixture.detectChanges();
		expect(document.activeElement).toBe(emailInput());
		expect(store.register).not.toHaveBeenCalled();
	});

	it.each([
		['short', 'abc', 'Use at least 6 characters.'],
		['long', 'x'.repeat(33), 'Use 32 characters or fewer.'],
		['pattern', 'bad code', 'Use only letters, numbers, or hyphens.'],
	])('validates and focuses a %s invite code', (_name, code, message) => {
		registrationToggle().click();
		fixture.detectChanges();
		const email = emailInput();
		email.value = 'owner@example.test';
		email.dispatchEvent(new Event('input'));
		const invite = fixture.nativeElement.querySelector(
			'#invite-code',
		) as HTMLInputElement;
		invite.value = code;
		invite.dispatchEvent(new Event('input'));
		submitForm();
		fixture.detectChanges();

		expect(document.activeElement).toBe(invite);
		expect(fixture.nativeElement.textContent).toContain(message);
		expect(store.register).not.toHaveBeenCalled();
	});

	it('does not dispatch while an access command is pending', () => {
		const email = emailInput();
		email.value = 'owner@example.test';
		email.dispatchEvent(new Event('input'));
		store.sending.set(true);
		fixture.detectChanges();
		submitForm();

		expect(email.disabled).toBe(true);
		expect(store.requestMagicLink).not.toHaveBeenCalled();

		store.sending.set(false);
		fixture.detectChanges();
		registrationToggle().click();
		fixture.detectChanges();
		const invite = fixture.nativeElement.querySelector(
			'#invite-code',
		) as HTMLInputElement;
		invite.value = 'TRACK-01';
		invite.dispatchEvent(new Event('input'));
		store.sending.set(true);
		fixture.detectChanges();
		submitForm();
		expect(store.register).not.toHaveBeenCalled();
	});

	it('dispatches passkey intent and reflects capability and progress state', () => {
		const passkey = fixture.nativeElement.querySelector(
			'.passkey-button',
		) as HTMLButtonElement;
		passkey.click();
		expect(store.authenticateWithPasskey).toHaveBeenCalledWith({
			operation: 'authenticate-passkey',
		});

		store.working.set(true);
		fixture.detectChanges();
		expect(passkey.disabled).toBe(true);
		expect(passkey.textContent).toContain('Waiting for passkey');

		store.working.set(false);
		store.webAuthnAvailable.set(false);
		fixture.detectChanges();
		expect(passkey.disabled).toBe(true);
	});
});
