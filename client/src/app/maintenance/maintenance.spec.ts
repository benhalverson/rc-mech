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

	it('renders local consumable history while the optional report is loading', async () => {
		http
			.expectOne(
				(request) =>
					request.url === '/api/v1/cars' &&
					request.params.get('archived') === 'all',
			)
			.flush({ cars: [] });
		http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 'UTC' });
		http
			.expectOne('/api/v1/maintenance-plans')
			.flush({ maintenancePlans: [], activity: [] });
		http.expectOne('/api/v1/service-records').flush({ serviceRecords: [] });
		http
			.expectOne('/api/v1/consumable-maintenance')
			.flush({ consumableMaintenance: [] });
		const report = http.expectOne('/api/v1/consumables/report');
		const consumables = fixture.nativeElement.querySelector(
			'.consumable-ledger',
		) as HTMLElement;
		await vi.waitFor(() => {
			fixture.detectChanges();
			expect(consumables.textContent).toContain('No consumable changes yet');
		});
		expect(consumables.textContent).not.toContain('Reading consumable history');
		report.flush({ report: {} });
	});

	it('falls back to local consumable reporting when the aggregate read fails', async () => {
		http
			.expectOne(
				(request) =>
					request.url === '/api/v1/cars' &&
					request.params.get('archived') === 'all',
			)
			.flush({ cars: [] });
		http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 'UTC' });
		http
			.expectOne('/api/v1/maintenance-plans')
			.flush({ maintenancePlans: [], activity: [] });
		http.expectOne('/api/v1/service-records').flush({ serviceRecords: [] });
		http
			.expectOne('/api/v1/consumable-maintenance')
			.flush({ consumableMaintenance: [] });
		http
			.expectOne('/api/v1/consumables/report')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		await fixture.whenStable();
		fixture.detectChanges();

		const consumables = fixture.nativeElement.querySelector(
			'.consumable-ledger',
		) as HTMLElement;
		expect(consumables.textContent).toContain('No consumable changes yet');
		expect(consumables.querySelector('[role="alert"]')).toBeNull();
	});

	it('identifies consumable history when its required read fails', async () => {
		http
			.expectOne(
				(request) =>
					request.url === '/api/v1/cars' &&
					request.params.get('archived') === 'all',
			)
			.flush({ cars: [] });
		http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 'UTC' });
		http
			.expectOne('/api/v1/maintenance-plans')
			.flush({ maintenancePlans: [], activity: [] });
		http.expectOne('/api/v1/service-records').flush({ serviceRecords: [] });
		http
			.expectOne('/api/v1/consumable-maintenance')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		http.expectOne('/api/v1/consumables/report').flush({ report: {} });
		await fixture.whenStable();
		fixture.detectChanges();

		const consumables = fixture.nativeElement.querySelector(
			'.consumable-ledger',
		) as HTMLElement;
		expect(consumables.querySelector('[role="alert"]')?.textContent).toContain(
			'Consumable history could not be loaded.',
		);
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

	it('renders an unauthorized state and retries cockpit reads', async () => {
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
		expect(requests.map((request) => request.request.url).sort()).toEqual(
			[
				'/api/v1/cars',
				'/api/v1/preferences/timezone',
				'/api/v1/maintenance-plans',
				'/api/v1/service-records',
			].sort(),
		);
		for (const request of requests) {
			if (request.request.url === '/api/v1/cars') request.flush({ cars: [] });
			else if (request.request.url === '/api/v1/preferences/timezone')
				request.flush({ timezone: 'UTC' });
			else if (request.request.url === '/api/v1/maintenance-plans')
				request.flush({ maintenancePlans: [], activity: [] });
			else if (request.request.url === '/api/v1/service-records')
				request.flush({ serviceRecords: [] });
		}
	});
});
