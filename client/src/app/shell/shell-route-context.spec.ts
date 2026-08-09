import { TestBed } from '@angular/core/testing';
import { NavigationEnd, Router } from '@angular/router';
import { Observable, Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	carWorkspaceRouteFromUrl,
	ShellRouteContext,
} from './shell-route-context';

describe('carWorkspaceRouteFromUrl', () => {
	it('recognizes every car workspace section and URL decoration', () => {
		for (const section of [
			'overview',
			'build',
			'setups',
			'photos',
			'drive-sessions',
			'voice',
		] as const)
			expect(
				carWorkspaceRouteFromUrl(
					`/garage/car%2Fone;source=picker/${section};view=full?filter=all#top`,
				),
			).toEqual({ carId: 'car/one', section });
	});

	it('rejects non-car, incomplete, unknown, and malformed routes', () => {
		expect(carWorkspaceRouteFromUrl('/garage')).toBeNull();
		expect(carWorkspaceRouteFromUrl('/cars/car-1/overview')).toBeNull();
		expect(carWorkspaceRouteFromUrl('/garage/car-1/unknown')).toBeNull();
		expect(carWorkspaceRouteFromUrl('/garage/%/overview')).toBeNull();
	});
});

describe('ShellRouteContext', () => {
	afterEach(() => TestBed.resetTestingModule());

	it('tracks redirected navigation and releases the router observer', () => {
		const events = new Subject<unknown>();
		const disposed = vi.fn();
		const observable = new Observable<unknown>((subscriber) => {
			const subscription = events.subscribe(subscriber);
			return () => {
				disposed();
				subscription.unsubscribe();
			};
		});
		TestBed.configureTestingModule({
			providers: [
				ShellRouteContext,
				{
					provide: Router,
					useValue: { url: '/garage', events: observable },
				},
			],
		});

		const context = TestBed.inject(ShellRouteContext);
		expect(context.carWorkspace()).toBeNull();
		expect(context.carId()).toBeNull();
		expect(context.section()).toBeNull();

		events.next(new NavigationEnd(1, '/legacy', '/garage/car-1/photos'));
		expect(context.carWorkspace()).toEqual({
			carId: 'car-1',
			section: 'photos',
		});
		expect(context.carId()).toBe('car-1');
		expect(context.section()).toBe('photos');

		TestBed.resetTestingModule();
		expect(disposed).toHaveBeenCalledOnce();
	});
});
