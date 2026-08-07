import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
	TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
	provideRouter,
	Routes,
	withComponentInputBinding,
} from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CarBuild } from './car-build';
import { CarOverview } from './car-overview';
import { CarPhotos } from './car-photos';
import { CarRuns } from './car-runs';
import { CarSetups } from './car-setups';
import { CarStore } from './car-store';

const testRoutes: Routes = [
	{
		path: 'garage/:carId/overview',
		component: CarOverview,
		providers: [CarStore],
	},
	{
		path: 'garage/:carId/build',
		component: CarBuild,
		providers: [CarStore],
	},
	{
		path: 'garage/:carId/setups',
		component: CarSetups,
		providers: [CarStore],
	},
	{
		path: 'garage/:carId/photos',
		component: CarPhotos,
		providers: [CarStore],
	},
	{
		path: 'garage/:carId/runs',
		component: CarRuns,
		providers: [CarStore],
	},
];

describe('Car section routes', () => {
	let harness: RouterTestingHarness;
	let http: HttpTestingController;

	beforeEach(async () => {
		await TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				provideRouter(testRoutes, withComponentInputBinding()),
			],
		}).compileComponents();
		http = TestBed.inject(HttpTestingController);
		harness = await RouterTestingHarness.create();
	});

	afterEach(() => http.verify());

	const car = {
		id: 'car-1',
		name: 'Red Runner',
		make: 'Associated',
		model: 'B7',
		archivedAt: null,
	};

	const flush = (request: TestRequest): void => {
		const url = request.request.url;
		if (url === '/api/v1/cars/car-1') request.flush({ car });
		else if (url === '/api/v1/cars/car-1/components')
			request.flush({ components: [] });
		else if (url === '/api/v1/cars/car-1/setups') request.flush({ setups: [] });
		else if (url === '/api/v1/cars') request.flush({ cars: [car] });
		else if (url === '/api/v1/cars/car-1/photos') request.flush({ photos: [] });
		else if (url === '/api/v1/cars/car-1/drives')
			request.flush({ driveSessions: [] });
		else if (url === '/api/v1/preferences/timezone')
			request.flush({ timezone: 'UTC' });
		else throw new Error(`Unexpected Car section read: ${url}`);
	};

	it.each([
		{
			path: 'overview',
			urls: ['/api/v1/cars/car-1'],
			visible: 'Car overview',
		},
		{
			path: 'build',
			urls: ['/api/v1/cars/car-1', '/api/v1/cars/car-1/components'],
			visible: 'No components recorded',
		},
		{
			path: 'setups',
			urls: ['/api/v1/cars/car-1', '/api/v1/cars', '/api/v1/cars/car-1/setups'],
			visible: 'No setup snapshots yet',
		},
		{
			path: 'photos',
			urls: ['/api/v1/cars/car-1', '/api/v1/cars/car-1/photos'],
			visible: 'No photos yet',
		},
		{
			path: 'runs',
			urls: [
				'/api/v1/cars/car-1',
				'/api/v1/cars/car-1/drives',
				'/api/v1/preferences/timezone',
			],
			visible: 'No drive sessions recorded',
		},
	])('deep-links to $path and requests only its section data', async ({
		path,
		urls,
		visible,
	}) => {
		await harness.navigateByUrl(`/garage/car-1/${path}`);
		const requests = http.match(() => true);
		for (const request of requests) flush(request);
		await Promise.resolve();
		harness.detectChanges();
		const nestedRequests: TestRequest[] = [];
		if (path === 'setups' || path === 'photos') {
			let nested: TestRequest | undefined;
			await vi.waitFor(() => {
				nested = http.expectOne(
					path === 'setups'
						? '/api/v1/cars/car-1/setups'
						: '/api/v1/cars/car-1/photos',
				);
			});
			if (nested) nestedRequests.push(nested);
		}
		for (const request of nestedRequests) flush(request);
		await harness.fixture.whenStable();
		harness.detectChanges();
		expect(
			[...requests, ...nestedRequests]
				.map((request) => request.request.url)
				.sort(),
		).toEqual([...urls].sort());

		expect(harness.routeNativeElement?.textContent).toContain(visible);
		expect(
			harness.routeNativeElement?.querySelector(
				'[data-route-focus][tabindex="-1"]',
			),
		).toBeTruthy();
		expect(
			harness.routeNativeElement
				?.querySelector(
					'nav[aria-label="Car detail sections"] a[aria-current="page"]',
				)
				?.textContent?.toLowerCase(),
		).toContain(path);
	});

	it('shows a loading state and retries a failed car read', async () => {
		await harness.navigateByUrl('/garage/car-1/overview');
		expect(harness.routeNativeElement?.textContent).toContain(
			'Opening the car overview',
		);
		http
			.expectOne('/api/v1/cars/car-1')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		await harness.fixture.whenStable();
		harness.detectChanges();
		const alert = harness.routeNativeElement?.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain('could not be loaded');

		(alert?.querySelector('button') as HTMLButtonElement).click();
		let retry: TestRequest | undefined;
		await vi.waitFor(() => {
			retry = http.expectOne('/api/v1/cars/car-1');
		});
		retry?.flush({ car });
		await harness.fixture.whenStable();
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain('Car overview');
	});

	it('keeps an archived car readable while hiding build mutations', async () => {
		await harness.navigateByUrl('/garage/car-1/build');
		http.expectOne('/api/v1/cars/car-1').flush({
			car: { ...car, archivedAt: '2026-08-07T00:00:00.000Z' },
		});
		http
			.expectOne((request) => request.url === '/api/v1/cars/car-1/components')
			.flush({ components: [] });
		await harness.fixture.whenStable();
		harness.detectChanges();

		expect(harness.routeNativeElement?.textContent).toContain(
			'changes are disabled until it is restored',
		);
		expect(
			[...(harness.routeNativeElement?.querySelectorAll('button') ?? [])].some(
				(button) => button.textContent?.includes('Add'),
			),
		).toBe(false);
	});
});
