import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
	TestRequest,
} from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BreakpointObserver } from '@angular/cdk/layout';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import {
	provideRouter,
	Router,
	withDisabledInitialNavigation,
} from '@angular/router';
import { vi } from 'vitest';
import { of } from 'rxjs';
import { App } from './app';
import { OwnerSessionStore } from './owner-session-store';
import { RouteTransitionAnnouncer } from './route-transition-announcer';

describe('App workspace shell', () => {
	let fixture: ComponentFixture<App>;
	let http: HttpTestingController;
	let mobile: boolean;

	beforeEach(async () => {
		mobile = false;
		await TestBed.configureTestingModule({
			imports: [App],
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				provideRouter([], withDisabledInitialNavigation()),
				provideNoopAnimations(),
				OwnerSessionStore,
				{
					provide: BreakpointObserver,
					useValue: { observe: () => of({ matches: mobile }) },
				},
			],
		}).compileComponents();
		http = TestBed.inject(HttpTestingController);
	});

	afterEach(() => http.verify());

	it('renders the public route outlet while signed out', async () => {
		fixture = TestBed.createComponent(App);
		fixture.detectChanges();
		http.expectOne('/api/auth/get-session').flush(null);
		await fixture.whenStable();
		fixture.detectChanges();
		expect(fixture.nativeElement.querySelector('router-outlet')).toBeTruthy();
		expect(fixture.nativeElement.querySelector('main')).toBeFalsy();
	});

	it('renders exactly one authenticated shell and main landmark', async () => {
		fixture = TestBed.createComponent(App);
		fixture.detectChanges();
		http.expectOne('/api/auth/get-session').flush({
			session: { id: 'session-1' },
			user: { email: 'owner@example.test' },
		});
		await fixture.whenStable();
		fixture.detectChanges();
		expect(
			fixture.nativeElement.querySelectorAll('.workspace-shell'),
		).toHaveLength(1);
		expect(
			fixture.nativeElement.querySelectorAll(
				'nav[aria-label="Primary workspace"]',
			),
		).toHaveLength(1);
		expect(fixture.nativeElement.querySelectorAll('main')).toHaveLength(1);
		const root = fixture.nativeElement as HTMLElement;
		const navigation = root.querySelector('.workspace-nav');
		if (!navigation) throw new Error('Workspace navigation was not rendered.');
		expect(navigation.classList.contains('nav-open')).toBe(true);
		root
			.querySelector('a[routerLink="/garage"]')
			?.dispatchEvent(new Event('click'));
		fixture.detectChanges();
		expect(navigation.classList.contains('nav-open')).toBe(true);
		(fixture.componentInstance as unknown as { closeNav(): void }).closeNav();
		fixture.detectChanges();
		expect(navigation.classList.contains('nav-open')).toBe(false);
		(fixture.componentInstance as unknown as { openNav(): void }).openNav();
		fixture.detectChanges();
		expect(navigation.classList.contains('nav-open')).toBe(true);
		TestBed.inject(RouteTransitionAnnouncer).start();
		fixture.detectChanges();
		const loadingState = fixture.nativeElement.querySelector('.route-state');
		expect(loadingState.textContent).toContain('Loading page');
		expect(loadingState.getAttribute('aria-hidden')).toBe('true');
		expect(loadingState.hasAttribute('role')).toBe(false);
	});

	it('signs out through the shared session store and returns to public routing', async () => {
		const navigate = vi
			.spyOn(TestBed.inject(Router), 'navigate')
			.mockResolvedValue(true);
		fixture = TestBed.createComponent(App);
		fixture.detectChanges();
		http.expectOne('/api/auth/get-session').flush({
			session: { id: 'session-1' },
			user: { email: 'owner@example.test' },
		});
		await fixture.whenStable();
		fixture.detectChanges();

		const signOut = [...fixture.nativeElement.querySelectorAll('button')].find(
			(button: HTMLButtonElement) => button.textContent?.trim() === 'Sign out',
		) as HTMLButtonElement | undefined;
		expect(signOut).toBeTruthy();
		signOut?.click();
		http.expectOne('/api/auth/sign-out').flush({ status: true });
		fixture.detectChanges();
		expect(fixture.nativeElement.querySelector('.workspace-shell')).toBeFalsy();
		expect(fixture.nativeElement.querySelector('router-outlet')).toBeTruthy();

		let sessionRequest: TestRequest | undefined;
		await vi.waitFor(() => {
			sessionRequest = http.expectOne('/api/auth/get-session');
		});
		sessionRequest?.flush(null);
		await fixture.whenStable();
		fixture.detectChanges();

		expect(fixture.nativeElement.querySelector('.workspace-shell')).toBeFalsy();
		expect(fixture.nativeElement.querySelector('router-outlet')).toBeTruthy();
		expect(navigate).toHaveBeenCalledWith(['/sign-in']);
	});

	it('supports every mobile navigation control and closes after selection', async () => {
		mobile = true;
		vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
		fixture = TestBed.createComponent(App);
		fixture.detectChanges();
		http.expectOne('/api/auth/get-session').flush({
			session: { id: 'session-1' },
			user: { email: 'owner@example.test' },
		});
		await fixture.whenStable();
		fixture.detectChanges();

		const root = fixture.nativeElement as HTMLElement;
		const navigation = root.querySelector('.workspace-nav');
		const toggle = root.querySelector('.nav-toggle') as HTMLButtonElement;
		if (!navigation) throw new Error('Workspace navigation was not rendered.');

		toggle.click();
		fixture.detectChanges();
		expect(navigation.classList.contains('nav-open')).toBe(true);
		(root.querySelector('.workspace-backdrop') as HTMLButtonElement).click();
		fixture.detectChanges();
		expect(navigation.classList.contains('nav-open')).toBe(false);

		toggle.click();
		fixture.detectChanges();
		(root.querySelector('.nav-close') as HTMLButtonElement).click();
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

	it('shows navigation and sign-out failures with working retry controls', async () => {
		fixture = TestBed.createComponent(App);
		fixture.detectChanges();
		http.expectOne('/api/auth/get-session').flush({
			session: { id: 'session-1' },
			user: { email: 'owner@example.test' },
		});
		await fixture.whenStable();

		const transition = TestBed.inject(RouteTransitionAnnouncer);
		const retry = vi
			.spyOn(transition, 'retry')
			.mockImplementation(() => undefined);
		transition.error.set('This page could not be loaded. Try again.');
		fixture.detectChanges();
		const routeError = fixture.nativeElement.querySelector(
			'.route-state.error-state',
		) as HTMLElement;
		expect(routeError.textContent).toContain('could not be loaded');
		(routeError.querySelector('button') as HTMLButtonElement).click();
		expect(retry).toHaveBeenCalledTimes(1);
		transition.error.set('');
		fixture.detectChanges();

		const signOut = [...fixture.nativeElement.querySelectorAll('button')].find(
			(button: HTMLButtonElement) => button.textContent?.trim() === 'Sign out',
		) as HTMLButtonElement;
		signOut.click();
		http
			.expectOne('/api/auth/sign-out')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		fixture.detectChanges();
		expect(
			fixture.nativeElement.querySelector('[role="alert"]').textContent,
		).toContain('could not sign you out');
	});

	it('initializes without browser globals for non-browser rendering', () => {
		const browserWindow = window;
		TestBed.inject(Router);
		vi.stubGlobal('window', undefined);
		try {
			const app = TestBed.runInInjectionContext(() => new App());
			expect(app).toBeInstanceOf(App);
		} finally {
			vi.stubGlobal('window', browserWindow);
		}
	});

	it('initializes mobile navigation from the browser media query', async () => {
		mobile = true;
		Object.defineProperty(window, 'matchMedia', {
			configurable: true,
			value: vi.fn(() => ({ matches: true }) as MediaQueryList),
		});
		try {
			fixture = TestBed.createComponent(App);
			fixture.detectChanges();
			http.expectOne('/api/auth/get-session').flush(null);
			await fixture.whenStable();
			const component = fixture.componentInstance as unknown as {
				mobileNav(): boolean;
				navOpen(): boolean;
			};
			expect(component.mobileNav()).toBe(true);
			expect(component.navOpen()).toBe(false);
		} finally {
			Reflect.deleteProperty(window, 'matchMedia');
		}
	});
});
