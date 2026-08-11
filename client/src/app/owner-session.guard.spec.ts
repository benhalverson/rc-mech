import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
	provideRouter,
	Router,
	RouterOutlet,
	UrlSegment,
} from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfflineWorkspaceAccess } from './offline/offline-workspace-access';
import { OfflineWorkspaceStore } from './offline/offline-workspace-store';
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
	const sessionStore = { resolved: vi.fn(), resolutionFailed: vi.fn() };
	const offlineAccess = { restore: vi.fn() };
	const offlineWorkspace = { prepare: vi.fn(), openOffline: vi.fn() };

	beforeEach(() => {
		loadPrivateFeature = privateFeatureLoader();
		sessionStore.resolved.mockReset();
		sessionStore.resolutionFailed.mockReset().mockReturnValue(false);
		offlineAccess.restore.mockReset();
		offlineWorkspace.prepare.mockReset();
		offlineWorkspace.openOffline.mockReset();
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
				{ provide: OfflineWorkspaceAccess, useValue: offlineAccess },
				{ provide: OfflineWorkspaceStore, useValue: offlineWorkspace },
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
			session: {
				id: 'session-1',
				expiresAt: '2026-08-12T12:00:00.000Z',
			},
			user: { id: 'user-1', email: 'owner@example.test' },
		});
		await router.navigateByUrl('/garage/car-1/photos');

		expect(loadPrivateFeature).toHaveBeenCalledTimes(1);
		expect(sessionStore.resolved).toHaveBeenCalledTimes(1);
		expect(offlineWorkspace.prepare).toHaveBeenCalledWith({
			owner: {
				key: 'user-1',
				email: 'owner@example.test',
				offlineUntil: '2026-08-12T12:00:00.000Z',
			},
		});
		expect(router.url).toBe('/garage/car-1/photos');
	});

	it('opens a still-valid local Garage only after the live session request fails', async () => {
		const snapshot = {
			ownerKey: 'user-1',
			ownerEmail: 'owner@example.test',
			offlineUntil: '2026-08-12T12:00:00.000Z',
			preparedAt: '2026-08-11T12:00:00.000Z',
			cars: [{ id: 'car-1', name: 'Offline buggy' }],
		};
		sessionStore.resolved.mockResolvedValue(null);
		sessionStore.resolutionFailed.mockReturnValue(true);
		offlineAccess.restore.mockResolvedValue(snapshot);

		await router.navigateByUrl('/garage/car-1/photos');

		expect(loadPrivateFeature).toHaveBeenCalledOnce();
		expect(offlineWorkspace.openOffline).toHaveBeenCalledWith({ snapshot });
		expect(router.url).toBe('/garage/car-1/photos');
	});

	it('keeps a live session authorized without claiming readiness from incomplete identity data', async () => {
		sessionStore.resolved.mockResolvedValue({
			session: { id: 'session-1' },
			user: { email: 'owner@example.test' },
		});

		const result = await TestBed.runInInjectionContext(() =>
			ownerSessionCanMatch(
				{ path: 'garage' },
				[new UrlSegment('garage', {})],
				router.routerState.snapshot.root,
			),
		);

		expect(result).toBe(true);
		expect(offlineWorkspace.prepare).not.toHaveBeenCalled();
	});

	it('redirects when failed-session recovery has no usable local Garage', async () => {
		sessionStore.resolved.mockResolvedValue(null);
		sessionStore.resolutionFailed.mockReturnValue(true);
		offlineAccess.restore.mockResolvedValueOnce(null);

		await router.navigateByUrl('/garage/car-1/photos');
		expect(router.url).toContain('/sign-in');

		offlineAccess.restore.mockRejectedValueOnce(new Error('IndexedDB failed'));
		await router.navigateByUrl('/garage/car-1/photos');
		expect(router.url).toContain('/sign-in');
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
