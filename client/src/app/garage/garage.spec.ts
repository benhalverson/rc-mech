import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
	type TestRequest,
} from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import {
	ActivatedRoute,
	convertToParamMap,
	provideRouter,
} from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Garage } from './garage';
import { GarageStore } from './garage-store';

describe('Garage', () => {
	let fixture: ComponentFixture<Garage>;
	let http: HttpTestingController;

	beforeEach(async () => {
		await TestBed.configureTestingModule({
			imports: [Garage],
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				provideNoopAnimations(),
				provideRouter([]),
				GarageStore,
			],
		}).compileComponents();
		http = TestBed.inject(HttpTestingController);
		fixture = TestBed.createComponent(Garage);
		fixture.detectChanges();
	});

	afterEach(() => http.verify());

	it('renders a loading state and then the empty collection guidance', async () => {
		expect(fixture.nativeElement.textContent).toContain(
			'Opening the garage ledger',
		);
		http.expectOne('/api/v1/cars').flush({ cars: [] });
		await fixture.whenStable();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'The garage is waiting',
		);
	});

	it('renders a collection error with a retry action', async () => {
		http
			.expectOne('/api/v1/cars')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		await fixture.whenStable();
		fixture.detectChanges();
		expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeTruthy();
		expect(fixture.nativeElement.textContent).toContain('Try again');
		const retry = fixture.nativeElement.querySelector(
			'[role="alert"] button',
		) as HTMLButtonElement;
		retry.click();
		let request: TestRequest | undefined;
		await vi.waitFor(() => {
			request = http.expectOne('/api/v1/cars');
		});
		request?.flush({ cars: [] });
	});

	it('renders accessible car links after collection loading', async () => {
		http
			.expectOne('/api/v1/cars')
			.flush({ cars: [{ id: 'car-1', name: 'Red Runner' }] });
		await fixture.whenStable();
		fixture.detectChanges();
		const link = fixture.nativeElement.querySelector(
			'a.car-row',
		) as HTMLAnchorElement;
		expect(link.textContent).toContain('Red Runner');
		expect(link.getAttribute('href')).toContain('/garage/car-1/overview');
		expect(
			fixture.nativeElement.querySelector('[data-route-focus][tabindex="-1"]'),
		).toBeTruthy();
	});

	it('reloads the collection when the archive filter changes', async () => {
		http.expectOne('/api/v1/cars').flush({ cars: [] });
		await fixture.whenStable();
		fixture.detectChanges();
		const toggle = [...fixture.nativeElement.querySelectorAll('button')].find(
			(button: HTMLButtonElement) =>
				button.textContent?.includes('Inspect archived cars'),
		) as HTMLButtonElement | undefined;
		toggle?.click();
		let request: TestRequest | undefined;
		await vi.waitFor(() => {
			request = http.expectOne(
				(candidate) =>
					candidate.url === '/api/v1/cars' &&
					candidate.params.get('archived') === 'all',
			);
		});
		request?.flush({ cars: [{ id: 'car-2', name: 'Retired buggy' }] });
	});
});

describe('Garage overview', () => {
	let fixture: ComponentFixture<Garage>;
	let http: HttpTestingController;

	beforeEach(async () => {
		await TestBed.configureTestingModule({
			imports: [Garage],
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				provideNoopAnimations(),
				provideRouter([]),
				GarageStore,
				{
					provide: ActivatedRoute,
					useValue: {
						snapshot: { paramMap: convertToParamMap({ carId: 'car-1' }) },
					},
				},
			],
		}).compileComponents();
		http = TestBed.inject(HttpTestingController);
		fixture = TestBed.createComponent(Garage);
		fixture.detectChanges();
		http
			.expectOne('/api/v1/cars')
			.flush({ cars: [{ id: 'car-1', name: 'Red Runner' }] });
	});

	afterEach(() => http.verify());

	it('renders overview server truth and accessible section navigation', async () => {
		http.expectOne('/api/v1/cars/car-1').flush({
			car: {
				id: 'car-1',
				name: 'Red Runner',
				make: 'Associated',
				model: 'B7',
				scale: '1/10',
			},
		});
		await fixture.whenStable();
		fixture.detectChanges();

		expect(fixture.nativeElement.textContent).toContain('Associated · B7');
		expect(
			fixture.nativeElement.querySelector(
				'nav[aria-label="Car detail sections"] a[aria-current="page"]',
			)?.textContent,
		).toContain('Overview');
	});

	it('renders and retries an overview error', async () => {
		http
			.expectOne('/api/v1/cars/car-1')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		await fixture.whenStable();
		fixture.detectChanges();
		const retry = fixture.nativeElement.querySelector(
			'[role="alert"] button',
		) as HTMLButtonElement;
		retry.click();
		let request: TestRequest | undefined;
		await vi.waitFor(() => {
			request = http.expectOne('/api/v1/cars/car-1');
		});
		request?.flush({ car: { id: 'car-1', name: 'Red Runner' } });
	});

	it('archives a car and refreshes collection and overview resources', async () => {
		http
			.expectOne('/api/v1/cars/car-1')
			.flush({ car: { id: 'car-1', name: 'Red Runner', archivedAt: null } });
		await fixture.whenStable();
		fixture.detectChanges();
		const archive = [...fixture.nativeElement.querySelectorAll('button')].find(
			(button: HTMLButtonElement) =>
				button.textContent?.trim() === 'Archive car',
		) as HTMLButtonElement | undefined;
		archive?.click();
		const mutation = http.expectOne('/api/v1/cars/car-1/archive');
		expect(mutation.request.method).toBe('POST');
		mutation.flush({
			car: {
				id: 'car-1',
				name: 'Red Runner',
				archivedAt: '2026-08-07T00:00:00.000Z',
			},
		});
		let overview: TestRequest | undefined;
		await vi.waitFor(() => {
			overview = http.expectOne('/api/v1/cars/car-1');
		});
		http.expectOne('/api/v1/cars').flush({ cars: [] });
		overview?.flush({
			car: {
				id: 'car-1',
				name: 'Red Runner',
				archivedAt: '2026-08-07T00:00:00.000Z',
			},
		});
		await fixture.whenStable();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Restore car');
	});
});
