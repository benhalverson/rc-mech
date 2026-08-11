import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OfflineGarageGateway } from './offline-garage-gateway';

describe('OfflineGarageGateway', () => {
	let gateway: OfflineGarageGateway;
	let http: HttpTestingController;

	beforeEach(() => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				OfflineGarageGateway,
			],
		});
		gateway = TestBed.inject(OfflineGarageGateway);
		http = TestBed.inject(HttpTestingController);
	});

	afterEach(() => {
		http.verify();
		TestBed.resetTestingModule();
	});

	it('loads and parses the complete authenticated Car snapshot', async () => {
		const result = firstValueFrom(gateway.load());
		const request = http.expectOne(
			(candidate) =>
				candidate.url === '/api/v1/cars' &&
				candidate.params.get('archived') === 'all',
		);
		expect(request.request.withCredentials).toBe(true);
		request.flush({ cars: [{ id: 'car-1', name: 'Track buggy' }] });
		await expect(result).resolves.toEqual({
			cars: [{ id: 'car-1', name: 'Track buggy' }],
		});

		const malformed = firstValueFrom(gateway.load());
		http.expectOne('/api/v1/cars?archived=all').flush({ cars: [{ id: 4 }] });
		await expect(malformed).rejects.toThrow();
	});
});
