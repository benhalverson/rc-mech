import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, withDisabledInitialNavigation } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './app';
import { RouteTransitionAnnouncer } from './route-transition-announcer';

class FakeRouteTransitionAnnouncer {
	readonly loading = signal(false);
	readonly announcement = signal('');
	readonly error = signal('');
	readonly retry = vi.fn();
}

describe('App', () => {
	let fixture: ComponentFixture<App>;
	let transition: FakeRouteTransitionAnnouncer;

	beforeEach(async () => {
		transition = new FakeRouteTransitionAnnouncer();
		await TestBed.configureTestingModule({
			imports: [App],
			providers: [
				provideRouter([], withDisabledInitialNavigation()),
				{ provide: RouteTransitionAnnouncer, useValue: transition },
			],
		}).compileComponents();
		fixture = TestBed.createComponent(App);
		fixture.detectChanges();
	});

	afterEach(() => TestBed.resetTestingModule());

	it('renders only the public route outlet while idle', () => {
		const root = fixture.nativeElement as HTMLElement;
		expect(root.querySelector('router-outlet')).toBeTruthy();
		expect(root.querySelector('.route-state')).toBeFalsy();
	});

	it('announces route loading without presenting duplicate status', () => {
		transition.loading.set(true);
		transition.announcement.set('Loading page…');
		fixture.detectChanges();

		const root = fixture.nativeElement as HTMLElement;
		expect(root.querySelector('.route-announcement')?.textContent).toContain(
			'Loading page',
		);
		const loadingState = root.querySelector('.route-state');
		expect(loadingState?.textContent).toContain('Loading page');
		expect(loadingState?.getAttribute('aria-hidden')).toBe('true');
		expect(loadingState?.hasAttribute('role')).toBe(false);
	});

	it('presents route failures and retries them', () => {
		transition.error.set('This page could not be loaded. Try again.');
		fixture.detectChanges();

		const routeError = (fixture.nativeElement as HTMLElement).querySelector(
			'.route-state',
		) as HTMLElement;
		expect(routeError.getAttribute('role')).toBe('alert');
		(routeError.querySelector('button') as HTMLButtonElement).click();
		expect(transition.retry).toHaveBeenCalledOnce();
	});
});
