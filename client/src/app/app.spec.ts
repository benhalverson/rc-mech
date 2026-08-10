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
import type { ShellCar } from './shell/shell-car-gateway';
import { ShellCarStore } from './shell/shell-car-store';
import type { CarWorkspaceSection } from './shell/shell-route-context';
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

class FakeShellCarStore {
	readonly cars = signal<ShellCar[]>([]);
	readonly carId = signal<string | null>(null);
	readonly section = signal<CarWorkspaceSection | null>(null);
	readonly loading = signal(false);
	readonly error = signal('');
	readonly inCarWorkspace = computed(() => this.carId() !== null);
	readonly currentCar = computed(() => {
		const carId = this.carId();
		return this.cars().find((car) => car.id === carId) ?? null;
	});
	readonly retry = vi.fn();

	select(carId: string, section: CarWorkspaceSection): void {
		this.carId.set(carId);
		this.section.set(section);
	}
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
	let cars: FakeShellCarStore;
	let transition: FakeRouteTransitionAnnouncer;

	beforeEach(async () => {
		session = new FakeOwnerSessionStore();
		signOut = new FakeSignOutStore();
		viewport = new FakeResponsiveViewport();
		cars = new FakeShellCarStore();
		transition = new FakeRouteTransitionAnnouncer();
		await TestBed.configureTestingModule({
			imports: [App],
			providers: [
				provideRouter([], withDisabledInitialNavigation()),
				{ provide: OwnerSessionStore, useValue: session },
				{ provide: SignOutStore, useValue: signOut },
				{ provide: ResponsiveViewport, useValue: viewport },
				{ provide: ShellCarStore, useValue: cars },
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
		expect(root.textContent).toContain('Chassis Notes / Field notebook');
		expect(root.querySelector('main')).toBeTruthy();

		session.setChecking(false);
		fixture.detectChanges();
		expect(root.querySelector('router-outlet')).toBeTruthy();
		expect(root.querySelector('main')).toBeFalsy();
	});

	it('renders one desktop command bar and preserves route state behavior', () => {
		session.authenticate();
		const root = render();
		expect(root.querySelectorAll('.workspace-shell')).toHaveLength(1);
		expect(root.querySelector('.desktop-command-bar')).toBeTruthy();
		expect(root.querySelector('.mobile-command-bar')).toBeFalsy();
		expect(root.querySelectorAll('.desktop-primary-nav')).toHaveLength(1);
		expect(root.querySelectorAll('main')).toHaveLength(1);
		expect(root.textContent).toContain('owner@example.test');
		expect(root.querySelector('.context-rail')).toBeFalsy();
		expect(root.textContent).toContain('Chassis Notes');
		expect(root.textContent).not.toContain('RC Mech');

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

	it('renders current-car context only in the desktop car workspace', () => {
		session.authenticate();
		cars.select('car-1', 'photos');
		cars.loading.set(true);
		const root = render();
		let rail = root.querySelector('.context-rail') as HTMLElement;
		expect(rail.querySelector('[role="status"]')?.textContent).toContain(
			'Loading cars',
		);

		cars.loading.set(false);
		cars.error.set('The garage cars could not be loaded.');
		fixture.detectChanges();
		rail = root.querySelector('.context-rail') as HTMLElement;
		(rail.querySelector('[role="alert"] button') as HTMLButtonElement).click();
		expect(cars.retry).toHaveBeenCalledOnce();

		cars.error.set('');
		cars.cars.set([
			{
				id: 'car-1',
				name: 'Long current competition buggy name',
				archivedAt: null,
			},
			{ id: 'car-2', name: 'Archived truck', archivedAt: '2026-01-01' },
		]);
		fixture.detectChanges();
		rail = root.querySelector('.context-rail') as HTMLElement;
		expect(rail.textContent).toContain('Long current competition buggy name');
		expect(
			rail.querySelectorAll('nav[aria-label="Car detail sections"] a'),
		).toHaveLength(6);
		expect(rail.querySelector('a[aria-current="page"]')?.textContent).toContain(
			'Photos',
		);
		expect(rail.querySelectorAll('.car-option')).toHaveLength(2);
		expect(rail.textContent).toContain('Archived');
		cars.carId.set('car-2');
		fixture.detectChanges();
		expect(root.querySelector('.context-rail')?.textContent).toContain(
			'Archived record',
		);
		expect(
			(
				fixture.componentInstance as unknown as {
					carRoute(
						carId: string,
						section: CarWorkspaceSection | null,
					): string[];
				}
			).carRoute('car-3', null),
		).toEqual(['/garage', 'car-3', 'overview']);

		cars.carId.set(null);
		cars.section.set(null);
		fixture.detectChanges();
		expect(root.querySelector('.context-rail')).toBeFalsy();
	});

	it('dispatches sign-out and renders pending and failed outcomes', () => {
		session.authenticate();
		const root = render();
		const button = root.querySelector('.command-action') as HTMLButtonElement;

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

	it('keeps the mobile drawer inert while closed and manages focus for every close path', async () => {
		session.authenticate();
		viewport.mobile.set(true);
		vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
		const root = render();
		const navigation = root.querySelector('.workspace-nav') as HTMLElement;
		const toggle = root.querySelector('.command-icon') as HTMLButtonElement;

		expect(root.querySelector('.desktop-command-bar')).toBeFalsy();
		expect(root.querySelector('.mobile-command-bar')).toBeTruthy();
		expect(navigation.getAttribute('aria-hidden')).toBe('true');
		expect(navigation.hasAttribute('inert')).toBe(true);
		toggle.click();
		fixture.detectChanges();
		await Promise.resolve();
		expect(navigation.getAttribute('aria-modal')).toBe('true');
		expect(navigation.hasAttribute('inert')).toBe(false);
		expect(root.querySelector('.workspace-shell')?.hasAttribute('inert')).toBe(
			true,
		);
		expect(document.activeElement).toBe(root.querySelector('.nav-close'));
		const close = root.querySelector('.nav-close') as HTMLButtonElement;
		const signOutButton = navigation.querySelector(
			'.drawer-utility[type="button"]',
		) as HTMLButtonElement;
		signOut.outcome.set({
			status: 'pending',
			operation: 'sign-out',
			operationId: 1,
		});
		fixture.detectChanges();
		expect(signOutButton.textContent).toContain('Signing out');
		signOut.outcome.set({
			status: 'idle',
			operation: 'sign-out',
			operationId: null,
		});
		fixture.detectChanges();
		close.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'Tab',
				shiftKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);
		expect(document.activeElement).toBe(signOutButton);
		signOutButton.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'Tab',
				bubbles: true,
				cancelable: true,
			}),
		);
		expect(document.activeElement).toBe(close);
		const middleLink = navigation.querySelector(
			'.mobile-primary-nav a',
		) as HTMLAnchorElement;
		middleLink.focus();
		middleLink.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'Tab',
				bubbles: true,
				cancelable: true,
			}),
		);
		expect(document.activeElement).toBe(middleLink);

		close.click();
		fixture.detectChanges();
		expect(navigation.getAttribute('aria-hidden')).toBe('true');
		expect(document.activeElement).toBe(toggle);

		toggle.click();
		fixture.detectChanges();
		await Promise.resolve();
		(root.querySelector('.workspace-backdrop') as HTMLButtonElement).click();
		fixture.detectChanges();
		expect(document.activeElement).toBe(toggle);

		toggle.click();
		fixture.detectChanges();
		await Promise.resolve();
		navigation.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
		);
		fixture.detectChanges();
		expect(document.activeElement).toBe(toggle);

		for (const link of root.querySelectorAll<HTMLAnchorElement>(
			'.mobile-primary-nav a',
		)) {
			toggle.click();
			fixture.detectChanges();
			link.click();
			fixture.detectChanges();
			expect(navigation.getAttribute('aria-hidden')).toBe('true');
		}
		toggle.click();
		fixture.detectChanges();
		(
			navigation.querySelector(
				'.drawer-utility[type="button"]',
			) as HTMLButtonElement
		).click();
		fixture.detectChanges();
		expect(signOut.signOut).toHaveBeenCalledWith({ operation: 'sign-out' });
		expect(navigation.getAttribute('aria-hidden')).toBe('true');

		const inertOnly = document.createElement('div');
		const inertButton = document.createElement('button');
		inertButton.setAttribute('inert', '');
		inertOnly.append(inertButton);
		(
			fixture.componentInstance as unknown as {
				trapFocus(event: Event, container: HTMLElement): void;
			}
		).trapFocus(new KeyboardEvent('keydown', { key: 'Tab' }), inertOnly);
	});

	it('opens a full-width current-car picker with loading, failure, and selection states', async () => {
		session.authenticate();
		viewport.mobile.set(true);
		vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
		cars.select('car-1', 'build');
		cars.loading.set(true);
		const root = render();
		const toggle = root.querySelector(
			'.current-car-control',
		) as HTMLButtonElement;
		expect(toggle.textContent).toContain('Loading current car');

		toggle.click();
		fixture.detectChanges();
		await Promise.resolve();
		expect(root.querySelector('.car-picker')).toBeTruthy();
		expect(
			root.querySelector('.car-picker [role="status"]')?.textContent,
		).toContain('Loading cars');
		expect(document.activeElement).toBe(
			root.querySelector('.car-picker [aria-label="Close current car picker"]'),
		);
		let picker = root.querySelector('.car-picker') as HTMLElement;
		picker.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'Tab',
				bubbles: true,
				cancelable: true,
			}),
		);
		picker.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
		);
		fixture.detectChanges();
		expect(root.querySelector('.car-picker')).toBeFalsy();
		expect(document.activeElement).toBe(toggle);
		toggle.click();
		fixture.detectChanges();
		await Promise.resolve();

		cars.loading.set(false);
		cars.error.set('The garage cars could not be loaded.');
		fixture.detectChanges();
		(
			root.querySelector(
				'.car-picker [role="alert"] button',
			) as HTMLButtonElement
		).click();
		expect(cars.retry).toHaveBeenCalledOnce();

		cars.error.set('');
		cars.cars.set([]);
		fixture.detectChanges();
		expect(root.querySelector('.car-picker')?.textContent).toContain(
			'No cars are available',
		);

		cars.cars.set([
			{
				id: 'car-1',
				name: 'A very long current car name that must fit',
				archivedAt: null,
			},
			{ id: 'car-2', name: 'Archived truck', archivedAt: '2026-01-01' },
		]);
		fixture.detectChanges();
		expect(root.querySelectorAll('.picker-car')).toHaveLength(2);
		expect(
			root.querySelector('.picker-car[aria-current="true"]')?.textContent,
		).toContain('Current');
		(root.querySelectorAll('.picker-car')[1] as HTMLAnchorElement).click();
		fixture.detectChanges();
		expect(root.querySelector('.car-picker')).toBeFalsy();

		toggle.click();
		fixture.detectChanges();
		await Promise.resolve();
		picker = root.querySelector('.car-picker') as HTMLElement;
		(
			picker.querySelector(
				'[aria-label="Close current car picker"]',
			) as HTMLButtonElement
		).click();
		fixture.detectChanges();
		expect(document.activeElement).toBe(toggle);

		toggle.click();
		fixture.detectChanges();
		(root.querySelector('.picker-backdrop') as HTMLButtonElement).click();
		fixture.detectChanges();
		expect(document.activeElement).toBe(toggle);
	});

	it('resets mobile overlays when the breakpoint or current car changes', () => {
		session.authenticate();
		viewport.mobile.set(true);
		cars.select('car-1', 'overview');
		cars.cars.set([{ id: 'car-1', name: 'Buggy', archivedAt: null }]);
		const root = render();
		(root.querySelector('.command-icon') as HTMLButtonElement).click();
		fixture.detectChanges();
		expect(root.querySelector('.workspace-backdrop')).toBeTruthy();

		viewport.mobile.set(false);
		fixture.detectChanges();
		expect(root.querySelector('.workspace-backdrop')).toBeFalsy();
		expect(root.querySelector('.desktop-command-bar')).toBeTruthy();

		viewport.mobile.set(true);
		fixture.detectChanges();
		(root.querySelector('.current-car-control') as HTMLButtonElement).click();
		fixture.detectChanges();
		expect(root.querySelector('.car-picker')).toBeTruthy();
		cars.carId.set('car-2');
		fixture.detectChanges();
		expect(root.querySelector('.car-picker')).toBeFalsy();

		viewport.mobile.set(false);
		fixture.detectChanges();
		(
			fixture.componentInstance as unknown as {
				closeNav(restoreFocus?: boolean): void;
			}
		).closeNav();
	});

	it('shows fallback current-car labels and route failures with retry', () => {
		session.authenticate();
		viewport.mobile.set(true);
		cars.select('missing', 'overview');
		const root = render();
		expect(root.querySelector('.current-car-control')?.textContent).toContain(
			'Current car',
		);
		cars.error.set('offline');
		fixture.detectChanges();
		expect(root.querySelector('.current-car-control')?.textContent).toContain(
			'Current car unavailable',
		);

		transition.error.set('This page could not be loaded. Try again.');
		fixture.detectChanges();
		const routeError = root.querySelector('.route-state') as HTMLElement;
		expect(routeError.textContent).toContain('could not be loaded');
		(routeError.querySelector('button') as HTMLButtonElement).click();
		expect(transition.retry).toHaveBeenCalledOnce();
	});
});
