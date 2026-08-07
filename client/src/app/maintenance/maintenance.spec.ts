import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
	type TestRequest,
} from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Maintenance } from './maintenance';
import { MaintenanceStore } from './maintenance-store';

describe('Maintenance workspace', () => {
	let fixture: ComponentFixture<Maintenance>;
	let http: HttpTestingController;

	beforeEach(async () => {
		await TestBed.configureTestingModule({
			imports: [Maintenance],
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				MaintenanceStore,
			],
		}).compileComponents();
		http = TestBed.inject(HttpTestingController);
		fixture = TestBed.createComponent(Maintenance);
		fixture.detectChanges();
	});

	afterEach(() => http.verify());

	const flushInitialReads = (planFailure?: {
		status: number;
		statusText: string;
	}): void => {
		http
			.expectOne(
				(request) =>
					request.url === '/api/v1/cars' &&
					request.params.get('archived') === 'all',
			)
			.flush({ cars: [] });
		http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 'UTC' });
		const plans = http.expectOne('/api/v1/maintenance-plans');
		if (planFailure) plans.flush('failed', planFailure);
		else plans.flush({ maintenancePlans: [], activity: [] });
		http.expectOne('/api/v1/service-records').flush({ serviceRecords: [] });
		http
			.expectOne('/api/v1/consumable-maintenance')
			.flush({ consumableMaintenance: [] });
		http.expectOne('/api/v1/consumables/report').flush({ report: {} });
	};

	it('renders loading and empty states with a route focus target', async () => {
		expect(fixture.nativeElement.textContent).toContain(
			'Reading the care ledger',
		);
		flushInitialReads();
		await fixture.whenStable();
		fixture.detectChanges();

		expect(fixture.nativeElement.textContent).toContain(
			'No plans in this view',
		);
		expect(fixture.nativeElement.textContent).toContain(
			'No consumable changes yet',
		);
		expect(
			fixture.nativeElement.querySelector('[data-route-focus][tabindex="-1"]'),
		).toBeTruthy();
	});

	it('falls back from an invalid stored timezone', async () => {
		http
			.expectOne(
				(request) =>
					request.url === '/api/v1/cars' &&
					request.params.get('archived') === 'all',
			)
			.flush({ cars: [] });
		http
			.expectOne('/api/v1/preferences/timezone')
			.flush({ timezone: 'Not/A-Timezone' });
		http
			.expectOne('/api/v1/maintenance-plans')
			.flush({ maintenancePlans: [], activity: [] });
		http.expectOne('/api/v1/service-records').flush({ serviceRecords: [] });
		http
			.expectOne('/api/v1/consumable-maintenance')
			.flush({ consumableMaintenance: [] });
		http.expectOne('/api/v1/consumables/report').flush({ report: {} });
		await fixture.whenStable();
		fixture.detectChanges();

		const timezone = TestBed.inject(MaintenanceStore).timezone();
		expect(timezone).not.toBe('Not/A-Timezone');
		expect(() =>
			new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(),
		).not.toThrow();
	});

	it('renders an unauthorized state and retries all idempotent reads', async () => {
		flushInitialReads({ status: 401, statusText: 'Unauthorized' });
		await fixture.whenStable();
		fixture.detectChanges();
		const cockpit = fixture.nativeElement.querySelector(
			'.maintenance-cockpit',
		) as HTMLElement;
		expect(cockpit.querySelector('[role="alert"]')?.textContent).toContain(
			'session has expired',
		);
		const retry = [...cockpit.querySelectorAll('button')].find(
			(button) => button.textContent?.trim() === 'Try again',
		) as HTMLButtonElement | undefined;
		expect(retry).toBeTruthy();
		retry?.click();

		let carsRequest: TestRequest | undefined;
		await vi.waitFor(() => {
			carsRequest = http.expectOne((request) => request.url === '/api/v1/cars');
		});
		const requests: TestRequest[] = [
			...(carsRequest ? [carsRequest] : []),
			...http.match(() => true),
		];
		expect(requests).toHaveLength(6);
		for (const request of requests) {
			if (request.request.url === '/api/v1/cars') request.flush({ cars: [] });
			else if (request.request.url === '/api/v1/preferences/timezone')
				request.flush({ timezone: 'UTC' });
			else if (request.request.url === '/api/v1/maintenance-plans')
				request.flush({ maintenancePlans: [], activity: [] });
			else if (request.request.url === '/api/v1/service-records')
				request.flush({ serviceRecords: [] });
			else if (request.request.url === '/api/v1/consumable-maintenance')
				request.flush({ consumableMaintenance: [] });
			else request.flush({ report: {} });
		}
	});
});
