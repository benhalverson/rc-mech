import { computed, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
	provideRouter,
	Router,
	withDisabledInitialNavigation,
} from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './app';
import { OwnerSessionStore } from './owner-session-store';
import { RouteTransitionAnnouncer } from './route-transition-announcer';
import { ResponsiveViewport } from './shell/responsive-viewport';
import {
	type SignOutCommand,
	type SignOutOutcome,
	SignOutStore,
} from './shell/sign-out-store';

class FakeOwnerSessionStore {
	private readonly loading = signal(false);
	private readonly hasValue = signal(true);
	readonly session = {
		isLoading: this.loading,
		hasValue: this.hasValue,
	};
	readonly authenticated = signal(false);
	readonly ownerEmail = signal('Owner');

	setChecking(checking: boolean): void {
		this.loading.set(checking);
		this.hasValue.set(!checking);
	}

	authenticate(): void {
		this.authenticated.set(true);
		this.ownerEmail.set('owner@example.test');
	}
}

class FakeSignOutStore {
	readonly outcome = signal<SignOutOutcome>({
		status: 'idle',
		operation: 'sign-out',
		operationId: null,
	});
	readonly signingOut = computed(() => this.outcome().status === 'pending');
	readonly error = computed(() =>
		this.outcome().status === 'failed'
			? 'We could not sign you out. Try again.'
			: '',
	);
	readonly signOut = vi.fn((_command: SignOutCommand): void => undefined);
}

class FakeResponsiveViewport {
	readonly mobile = signal(false);
}

class FakeRouteTransitionAnnouncer {
	readonly loading = signal(false);
	readonly announcement = signal('');
	readonly error = signal('');
	readonly retry = vi.fn();
}

describe('App workspace shell', () => {
	let fixture: ComponentFixture<App>;
	let session: FakeOwnerSessionStore;
	let signOut: FakeSignOutStore;
	let viewport: FakeResponsiveViewport;
	let transition: FakeRouteTransitionAnnouncer;

	beforeEach(async () => {
		session = new FakeOwnerSessionStore();
		signOut = new FakeSignOutStore();
		viewport = new FakeResponsiveViewport();
		transition = new FakeRouteTransitionAnnouncer();
		await TestBed.configureTestingModule({
			imports: [App],
			providers: [
				provideRouter([], withDisabledInitialNavigation()),
				{ provide: OwnerSessionStore, useValue: session },
				{ provide: SignOutStore, useValue: signOut },
				{ provide: ResponsiveViewport, useValue: viewport },
				{ provide: RouteTransitionAnnouncer, useValue: transition },
			],
		}).compileComponents();
	});

	afterEach(() => TestBed.resetTestingModule());

	const render = (): HTMLElement => {
		fixture = TestBed.createComponent(App);
		fixture.detectChanges();
		return fixture.nativeElement as HTMLElement;
	};

	it('renders checking and public signed-out states', () => {
		session.setChecking(true);
		const root = render();
		expect(root.querySelector('.checking')?.textContent).toContain(
			'Checking the garage latch',
		);
		expect(root.querySelector('main')).toBeTruthy();

		session.setChecking(false);
		fixture.detectChanges();
		expect(root.querySelector('router-outlet')).toBeTruthy();
		expect(root.querySelector('main')).toBeFalsy();
	});

	it('renders the authenticated desktop shell and route states', () => {
		session.authenticate();
		const root = render();
		expect(root.querySelectorAll('.workspace-shell')).toHaveLength(1);
		expect(
			root.querySelectorAll('nav[aria-label="Primary workspace"]'),
		).toHaveLength(1);
		expect(root.querySelectorAll('main')).toHaveLength(1);
		expect(root.textContent).toContain('owner@example.test');

		const navigation = root.querySelector('.workspace-nav');
		if (!navigation) throw new Error('Workspace navigation was not rendered.');
		expect(navigation.classList.contains('nav-open')).toBe(true);
		(fixture.componentInstance as unknown as { closeNav(): void }).closeNav();
		fixture.detectChanges();
		expect(navigation.classList.contains('nav-open')).toBe(false);
		(
			fixture.componentInstance as unknown as {
				openNav(navToggle: HTMLButtonElement): void;
			}
		).openNav(root.querySelector('.nav-toggle') as HTMLButtonElement);
		fixture.detectChanges();
		expect(navigation.classList.contains('nav-open')).toBe(true);
		(fixture.componentInstance as unknown as { selectNav(): void }).selectNav();
		expect(navigation.classList.contains('nav-open')).toBe(true);

		transition.loading.set(true);
		transition.announcement.set('Loading page…');
		fixture.detectChanges();
		const loadingState = root.querySelector('.route-state');
		expect(loadingState?.textContent).toContain('Loading page');
		expect(loadingState?.getAttribute('aria-hidden')).toBe('true');
		expect(loadingState?.hasAttribute('role')).toBe(false);
		expect(
			root.querySelector('.workspace-frame')?.getAttribute('aria-busy'),
		).toBe('true');
	});

	it('dispatches sign-out and renders pending and failed outcomes', () => {
		session.authenticate();
		const root = render();
		const button = root.querySelector('.actions button') as HTMLButtonElement;

		button.click();
		expect(signOut.signOut).toHaveBeenCalledWith({ operation: 'sign-out' });

		signOut.outcome.set({
			status: 'pending',
			operation: 'sign-out',
			operationId: 1,
		});
		fixture.detectChanges();
		expect(button.disabled).toBe(true);
		expect(button.getAttribute('aria-busy')).toBe('true');
		expect(button.textContent).toContain('Signing out');

		signOut.outcome.set({
			status: 'failed',
			operation: 'sign-out',
			operationId: 1,
			error: { kind: 'unavailable' },
		});
		fixture.detectChanges();
		expect(root.querySelector('[role="alert"]')?.textContent).toContain(
			'could not sign you out',
		);
		expect(button.disabled).toBe(false);

		signOut.outcome.set({
			status: 'succeeded',
			operation: 'sign-out',
			operationId: 1,
		});
		fixture.detectChanges();
		expect(root.querySelector('[role="alert"]')).toBeFalsy();
	});

	it('keeps mobile navigation inert while closed and restores toggle focus', () => {
		session.authenticate();
		viewport.mobile.set(true);
		vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
		const root = render();
		const navigation = root.querySelector('.workspace-nav');
		const toggle = root.querySelector('.nav-toggle') as HTMLButtonElement;
		if (!navigation) throw new Error('Workspace navigation was not rendered.');

		expect(navigation.classList.contains('nav-open')).toBe(false);
		expect(navigation.getAttribute('aria-hidden')).toBe('true');
		expect(navigation.hasAttribute('inert')).toBe(true);
		toggle.click();
		fixture.detectChanges();
		expect(navigation.classList.contains('nav-open')).toBe(true);
		expect(navigation.hasAttribute('aria-hidden')).toBe(false);
		expect(root.querySelector('.workspace-backdrop')).toBeTruthy();

		(root.querySelector('.workspace-backdrop') as HTMLButtonElement).click();
		fixture.detectChanges();
		expect(navigation.classList.contains('nav-open')).toBe(false);
		expect(document.activeElement).toBe(toggle);

		toggle.click();
		fixture.detectChanges();
		(root.querySelector('.nav-close') as HTMLButtonElement).click();
		fixture.detectChanges();
		expect(document.activeElement).toBe(toggle);
		(fixture.componentInstance as unknown as { selectNav(): void }).selectNav();
		fixture.detectChanges();
		expect(navigation.classList.contains('nav-open')).toBe(false);

		for (const link of root.querySelectorAll<HTMLAnchorElement>(
			'nav[aria-label="Primary workspace"] a',
		)) {
			toggle.click();
			fixture.detectChanges();
			link.dispatchEvent(
				new MouseEvent('click', { bubbles: true, cancelable: true }),
			);
			fixture.detectChanges();
			expect(navigation.classList.contains('nav-open')).toBe(false);
		}
	});

	it('synchronizes drawer state when the responsive capability changes', () => {
		session.authenticate();
		const root = render();
		const navigation = root.querySelector('.workspace-nav');
		if (!navigation) throw new Error('Workspace navigation was not rendered.');
		expect(navigation.classList.contains('nav-open')).toBe(true);

		viewport.mobile.set(true);
		fixture.detectChanges();
		expect(navigation.classList.contains('nav-open')).toBe(false);
		viewport.mobile.set(false);
		fixture.detectChanges();
		expect(navigation.classList.contains('nav-open')).toBe(true);
	});

	it('shows route failures with a working retry control', () => {
		transition.error.set('This page could not be loaded. Try again.');
		const root = render();
		const routeError = root.querySelector(
			'.route-state.error-state',
		) as HTMLElement;
		expect(routeError.textContent).toContain('could not be loaded');
		(routeError.querySelector('button') as HTMLButtonElement).click();
		expect(transition.retry).toHaveBeenCalledOnce();
	});
});
