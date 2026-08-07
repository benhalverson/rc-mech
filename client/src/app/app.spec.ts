import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
	TestRequest,
} from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import {
	provideRouter,
	Router,
	withDisabledInitialNavigation,
} from '@angular/router';
import { vi } from 'vitest';
import { App } from './app';
import { OwnerSessionStore } from './owner-session-store';
import { RouteTransitionAnnouncer } from './route-transition-announcer';

describe('App workspace shell', () => {
	let fixture: ComponentFixture<App>;
	let http: HttpTestingController;

	beforeEach(async () => {
		await TestBed.configureTestingModule({
			imports: [App],
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				provideRouter([], withDisabledInitialNavigation()),
				provideNoopAnimations(),
				OwnerSessionStore,
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
		expect(
			fixture.nativeElement.querySelector('.route-state').textContent,
		).toContain('Loading workspace');
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
});
