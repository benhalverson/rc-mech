import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
	provideRouter,
	Router,
	RouterOutlet,
	UrlSegment,
} from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ownerSessionCanMatch } from './owner-session.guard';
import { OwnerSessionStore } from './owner-session-store';

@Component({ selector: 'test-public-sign-in', template: '<h1>Sign in</h1>' })
class PublicSignIn {}

@Component({
	selector: 'test-private-photos',
	template: '<h1>Private photos</h1>',
})
class PrivatePhotos {}

@Component({
	selector: 'test-router-host',
	imports: [RouterOutlet],
	template: '<router-outlet />',
})
class RouterHost {}

const privateFeatureLoader = () =>
	vi.fn(async (): Promise<typeof PrivatePhotos> => PrivatePhotos);

describe('ownerSessionCanMatch', () => {
	let router: Router;
	let loadPrivateFeature: ReturnType<typeof privateFeatureLoader>;
	const sessionStore = { resolved: vi.fn() };

	beforeEach(() => {
		loadPrivateFeature = privateFeatureLoader();
		sessionStore.resolved.mockReset();
		TestBed.configureTestingModule({
			providers: [
				provideRouter([
					{ path: 'sign-in', component: PublicSignIn },
					{
						path: 'garage/:carId/photos',
						canMatch: [ownerSessionCanMatch],
						loadComponent: loadPrivateFeature,
					},
				]),
				{ provide: OwnerSessionStore, useValue: sessionStore },
			],
		});
		router = TestBed.inject(Router);
		TestBed.createComponent(RouterHost).detectChanges();
	});

	afterEach(() => {
		TestBed.resetTestingModule();
	});

	it('redirects signed-out deep links without importing the private feature', async () => {
		sessionStore.resolved.mockResolvedValue(null);
		await router.navigateByUrl('/garage/car-1/photos?mode=grid#gallery');

		expect(loadPrivateFeature).not.toHaveBeenCalled();
		expect(sessionStore.resolved).toHaveBeenCalledTimes(1);
		const redirected = router.parseUrl(router.url);
		expect(redirected.root.children['primary']?.segments[0]?.path).toBe(
			'sign-in',
		);
		expect(redirected.queryParams['returnTo']).toBe(
			'/garage/car-1/photos?mode=grid#gallery',
		);
	});

	it('imports and resolves an authenticated deep link after one session read', async () => {
		sessionStore.resolved.mockResolvedValue({
			session: { id: 'session-1' },
			user: { email: 'owner@example.test' },
		});
		await router.navigateByUrl('/garage/car-1/photos');

		expect(loadPrivateFeature).toHaveBeenCalledTimes(1);
		expect(sessionStore.resolved).toHaveBeenCalledTimes(1);
		expect(router.url).toBe('/garage/car-1/photos');
	});

	it('uses the matched segments when no current navigation is available', async () => {
		sessionStore.resolved.mockResolvedValue(null);
		const rootResult = await TestBed.runInInjectionContext(() =>
			ownerSessionCanMatch(
				{ path: 'garage' },
				[],
				router.routerState.snapshot.root,
			),
		);

		expect(rootResult).toEqual(
			router.createUrlTree(['/sign-in'], {
				queryParams: { returnTo: '/garage' },
			}),
		);

		const segmentResult = await TestBed.runInInjectionContext(() =>
			ownerSessionCanMatch(
				{ path: 'maintenance' },
				[new UrlSegment('maintenance', {})],
				router.routerState.snapshot.root,
			),
		);
		expect(segmentResult).toEqual(
			router.createUrlTree(['/sign-in'], {
				queryParams: { returnTo: '/maintenance' },
			}),
		);
	});
});
