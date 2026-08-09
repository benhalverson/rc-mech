import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
	type TestRequest,
} from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
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
		http.expectOne('/api/v1/cars').flush(null);
		await fixture.whenStable();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'The garage is waiting',
		);
	});

	it('creates the first car through an accessible Signal Form', async () => {
		vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
		http.expectOne('/api/v1/cars').flush({ cars: [] });
		await fixture.whenStable();
		fixture.detectChanges();
		const add = [...fixture.nativeElement.querySelectorAll('button')].find(
			(button: HTMLButtonElement) =>
				button.textContent?.trim() === 'Add the first car',
		) as HTMLButtonElement;
		add.click();
		fixture.detectChanges();
		const form = fixture.nativeElement.querySelector(
			'.car-form',
		) as HTMLFormElement;
		form.dispatchEvent(new Event('submit'));
		fixture.detectChanges();
		const name = form.querySelector('input') as HTMLInputElement;
		expect(document.activeElement).toBe(name);
		name.value = '   ';
		name.dispatchEvent(new Event('input'));
		form.dispatchEvent(new Event('submit'));
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Give this car a name before saving',
		);
		const internal = fixture.componentInstance as unknown as {
			carFields(): { errorSummary(): Array<{ message?: string }> };
		};
		Object.defineProperty(internal.carFields(), 'errorSummary', {
			configurable: true,
			value: () => [],
		});
		form.dispatchEvent(new Event('submit'));
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Review the car details',
		);

		name.value = 'Red Runner';
		name.dispatchEvent(new Event('input'));
		form.dispatchEvent(new Event('submit'));
		const mutation = http.expectOne('/api/v1/cars');
		expect(mutation.request.method).toBe('POST');
		expect(mutation.request.body).toEqual({ name: 'Red Runner' });
		mutation.flush({ car: { id: 'car-1', name: 'Red Runner' } });
		let refresh: TestRequest | undefined;
		await vi.waitFor(() => {
			refresh = http.expectOne('/api/v1/cars');
		});
		refresh?.flush({ cars: [{ id: 'car-1', name: 'Red Runner' }] });
		await fixture.whenStable();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Car added to the garage.',
		);
	});

	it('renders a session-expired collection error with a retry action', async () => {
		http
			.expectOne('/api/v1/cars')
			.flush('expired', { status: 401, statusText: 'Unauthorized' });
		await fixture.whenStable();
		fixture.detectChanges();
		expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeTruthy();
		expect(fixture.nativeElement.textContent).toContain(
			'Your garage session has expired',
		);
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

	it('renders a generic collection failure', async () => {
		http
			.expectOne('/api/v1/cars')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		await fixture.whenStable();
		fixture.detectChanges();

		expect(fixture.nativeElement.textContent).toContain(
			'Check the connection and try again',
		);
	});

	it('opens and cancels the toolbar create form', async () => {
		http
			.expectOne('/api/v1/cars')
			.flush({ cars: [{ id: 'car-1', name: 'Red Runner' }] });
		await fixture.whenStable();
		fixture.detectChanges();
		const button = (label: string): HTMLButtonElement =>
			[...fixture.nativeElement.querySelectorAll('button')].find(
				(candidate: HTMLButtonElement) =>
					candidate.textContent?.trim() === label,
			) as HTMLButtonElement;

		button('Add a car').click();
		fixture.detectChanges();
		expect(fixture.nativeElement.querySelector('.car-form')).toBeTruthy();
		button('Cancel').click();
		fixture.detectChanges();
		expect(fixture.nativeElement.querySelector('.car-form')).toBeNull();
	});

	it('submits normalized optional car fields and keeps failures editable', async () => {
		http.expectOne('/api/v1/cars').flush({ cars: [] });
		await fixture.whenStable();
		fixture.detectChanges();
		(
			[...fixture.nativeElement.querySelectorAll('button')].find(
				(button: HTMLButtonElement) =>
					button.textContent?.trim() === 'Add the first car',
			) as HTMLButtonElement
		).click();
		fixture.detectChanges();
		const form = fixture.nativeElement.querySelector(
			'.car-form',
		) as HTMLFormElement;
		const values = [
			' Red Runner ',
			' Associated ',
			' B7 ',
			' 1/10 ',
			' Buggy ',
			' Electric ',
		];
		for (const [index, input] of [
			...form.querySelectorAll('input'),
		].entries()) {
			input.value = values[index] ?? '';
			input.dispatchEvent(new Event('input'));
		}
		const notes = form.querySelector('textarea') as HTMLTextAreaElement;
		notes.value = ' Track car ';
		notes.dispatchEvent(new Event('input'));
		form.dispatchEvent(new Event('submit'));
		fixture.detectChanges();
		expect(form.textContent).toContain('Adding…');
		const store = TestBed.inject(GarageStore);
		expect(await store.createCar({ name: 'Blocked duplicate' })).toBeNull();
		const internal = fixture.componentInstance as unknown as {
			openCreate(): void;
			cancelEdit(): void;
		};
		internal.openCreate();
		internal.cancelEdit();
		form.dispatchEvent(new Event('submit'));
		const mutation = http.expectOne('/api/v1/cars');
		expect(mutation.request.body).toEqual({
			name: 'Red Runner',
			make: 'Associated',
			model: 'B7',
			scale: '1/10',
			vehicleType: 'Buggy',
			powerType: 'Electric',
			notes: 'Track car',
		});
		mutation.flush('offline', { status: 503, statusText: 'Unavailable' });
		await fixture.whenStable();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('could not be saved');
		expect(fixture.nativeElement.querySelector('.car-form')).toBeTruthy();

		form.dispatchEvent(new Event('submit'));
		http
			.expectOne('/api/v1/cars')
			.flush('expired', { status: 401, statusText: 'Unauthorized' });
		await fixture.whenStable();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('session has expired');
	});

	it('renders make and model fallbacks for mixed legacy car records', async () => {
		http.expectOne('/api/v1/cars').flush({
			cars: [
				{ id: 'car-1', name: 'Modern', make: 'Associated', model: 'B7' },
				{ id: 'car-2', name: 'Legacy', manufacturer: 'Tamiya' },
				{ id: 'car-3', name: 'Unknown' },
			],
		});
		await fixture.whenStable();
		fixture.detectChanges();
		const text = fixture.nativeElement.textContent;
		expect(text).toContain('Associated · B7');
		expect(text).toContain('Tamiya · Model not recorded');
		expect(text).toContain('Make not recorded · Model not recorded');
	});

	it('shows the archived empty state and toggles back to active cars', async () => {
		http.expectOne('/api/v1/cars').flush({ cars: [] });
		await fixture.whenStable();
		fixture.detectChanges();
		const toggle = (): HTMLButtonElement =>
			[...fixture.nativeElement.querySelectorAll('button')].find(
				(button: HTMLButtonElement) =>
					button.textContent?.includes('archived cars') ||
					button.textContent?.includes('active cars'),
			) as HTMLButtonElement;
		toggle().click();
		let archived: TestRequest | undefined;
		await vi.waitFor(() => {
			archived = http.expectOne(
				(request) => request.params.get('archived') === 'all',
			);
		});
		archived?.flush({ cars: [] });
		await fixture.whenStable();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('No archived cars');

		toggle().click();
		let active: TestRequest | undefined;
		await vi.waitFor(() => {
			active = http.expectOne((request) => !request.params.has('archived'));
		});
		active?.flush({ cars: [] });
	});
});
