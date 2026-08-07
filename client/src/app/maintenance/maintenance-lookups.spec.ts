import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MaintenanceLookups } from './maintenance-lookups';

describe('MaintenanceLookups', () => {
	let http: HttpTestingController;
	let lookups: MaintenanceLookups;

	beforeEach(() => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				MaintenanceLookups,
			],
		});
		http = TestBed.inject(HttpTestingController);
		lookups = TestBed.inject(MaintenanceLookups);
	});

	afterEach(() => http.verify());

	it('encodes car ids in component and tire lookup paths', () => {
		let components: unknown;
		let tires: unknown;
		lookups.components('car/one').subscribe((value) => {
			components = value;
		});
		lookups.currentTires('car/one').subscribe((value) => {
			tires = value;
		});

		http.expectOne('/api/v1/cars/car%2Fone/components').flush({
			components: [
				{ id: 'current', name: 'Motor' },
				{ id: 'removed', name: 'Old motor', removedAt: '2026-08-01' },
			],
		});
		http
			.expectOne('/api/v1/cars/car%2Fone/setups/current')
			.flush({ setup: { tires: { front: 'Pink' } } });

		expect(components).toEqual([{ id: 'current', name: 'Motor' }]);
		expect(tires).toEqual({ front: 'Pink' });
	});
});
