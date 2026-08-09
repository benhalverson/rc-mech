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
import { CarGateway } from '../car-gateway';
import { CarStore } from '../car-store';
import { CarPhotoGateway } from './car-photo-gateway';
import { CarPhotoStore } from './car-photo-store';
import { CarPhotos } from './car-photos';

const testRoutes: Routes = [
	{
		path: 'garage/:carId/photos',
		component: CarPhotos,
		providers: [CarGateway, CarPhotoGateway, CarPhotoStore, CarStore],
	},
];

describe('Car photos route', () => {
	let harness: RouterTestingHarness;

	let http: HttpTestingController;

	beforeEach(async () => {
		await TestBed.configureTestingModule({
			imports: [CarPhotos],
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				provideRouter(testRoutes, withComponentInputBinding()),
				CarGateway,
				CarPhotoGateway,
				CarPhotoStore,
				CarStore,
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

	it('stays idle until route input binding supplies a car', () => {
		const withoutInput = TestBed.createComponent(CarPhotos);
		withoutInput.detectChanges();
		http.expectNone((request) => request.url.includes('/cars//'));
		withoutInput.destroy();
	});

	it('does not retry an expired protected car read', async () => {
		await harness.navigateByUrl('/garage/car-1/photos');
		http
			.expectOne('/api/v1/cars/car-1')
			.flush('expired', { status: 401, statusText: 'Unauthorized' });
		await harness.fixture.whenStable();
		harness.detectChanges();
		expect(
			harness.routeNativeElement?.querySelector('[role="alert"] button'),
		).toBeNull();
	});

	it('retries the car record from the Photos leaf before loading the gallery', async () => {
		await harness.navigateByUrl('/garage/car-1/photos');
		http
			.expectOne('/api/v1/cars/car-1')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		await harness.fixture.whenStable();
		harness.detectChanges();
		const retry = harness.routeNativeElement?.querySelector(
			'[role="alert"] button',
		) as HTMLButtonElement;
		retry.click();
		let carRefresh: TestRequest | undefined;
		await vi.waitFor(() => {
			carRefresh = http.expectOne('/api/v1/cars/car-1');
		});
		carRefresh?.flush({ car });
		let photos: TestRequest | undefined;
		await vi.waitFor(() => {
			photos = http.expectOne('/api/v1/cars/car-1/photos');
		});
		photos?.flush({ photos: [] });
		await harness.fixture.whenStable();
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain('No photos yet');
	});
});
