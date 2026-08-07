import { TestBed } from '@angular/core/testing';
import {
	NavigationEnd,
	NavigationError,
	NavigationStart,
	Router,
} from '@angular/router';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RouteTransitionAnnouncer } from './route-transition-announcer';

describe('RouteTransitionAnnouncer', () => {
	let events: Subject<NavigationStart | NavigationEnd | NavigationError>;
	const navigateByUrl = vi.fn(async () => true);
	let transition: RouteTransitionAnnouncer;

	beforeEach(() => {
		events = new Subject();
		navigateByUrl.mockClear();
		TestBed.configureTestingModule({
			providers: [
				RouteTransitionAnnouncer,
				{
					provide: Router,
					useValue: { events: events.asObservable(), navigateByUrl },
				},
			],
		});
		transition = TestBed.inject(RouteTransitionAnnouncer);
	});

	afterEach(() => {
		events.complete();
		document.querySelector('[data-route-focus]')?.remove();
		TestBed.resetTestingModule();
	});

	it('publishes loading and accessible completion state and focuses the view heading', async () => {
		const heading = document.createElement('h2');
		heading.tabIndex = -1;
		heading.dataset['routeFocus'] = '';
		document.body.append(heading);

		events.next(new NavigationStart(1, '/maintenance'));
		expect(transition.loading()).toBe(true);
		expect(transition.announcement()).toBe('Loading page…');

		events.next(new NavigationEnd(1, '/maintenance', '/maintenance'));
		await Promise.resolve();

		expect(transition.loading()).toBe(false);
		expect(transition.announcement()).toBe('Opened Maintenance.');
		expect(document.activeElement).toBe(heading);
	});

	it('exposes a retry state for a failed lazy navigation', () => {
		events.next(new NavigationStart(2, '/settings'));
		events.next(
			new NavigationError(2, '/settings', new Error('chunk unavailable')),
		);

		expect(transition.loading()).toBe(false);
		expect(transition.error()).toBe(
			'This page could not be loaded. Try again.',
		);
		expect(transition.announcement()).toBe('');

		transition.retry();
		expect(navigateByUrl).toHaveBeenCalledWith('/settings');
	});

	it('announces public and unknown routes accurately', async () => {
		events.next(new NavigationEnd(3, '/sign-in', '/sign-in'));
		await Promise.resolve();
		expect(transition.announcement()).toBe('Opened Sign in.');

		events.next(new NavigationEnd(4, '/legal', '/legal'));
		await Promise.resolve();
		expect(transition.announcement()).toBe('Opened page.');
	});
});
