import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
	type TestRequest,
} from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
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
});
