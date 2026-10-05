import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import { FeatureFlagGateway } from './feature-flag-gateway';

describe('FeatureFlagGateway', () => {
	afterEach(() => TestBed.resetTestingModule());
	it('sends authenticated desired values and validates acknowledgements', async () => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				FeatureFlagGateway,
			],
		});
		const gateway = TestBed.inject(FeatureFlagGateway);
		const http = TestBed.inject(HttpTestingController);
		const success = firstValueFrom(gateway.save({ enabled: true }));
		const request = http.expectOne('/api/v1/feature-flags/driving-analysis');
		expect(request.request.method).toBe('PUT');
		expect(request.request.body).toEqual({ enabled: true });
		expect(request.request.withCredentials).toBe(true);
		expect(request.request.timeout).toBe(5000);
		request.flush({ enabled: true });
		await expect(success).resolves.toEqual({ enabled: true });
		const invalid = firstValueFrom(gateway.save({ enabled: false }));
		http
			.expectOne('/api/v1/feature-flags/driving-analysis')
			.flush({ enabled: 'false' });
		await expect(invalid).rejects.toThrow();
		http.verify();
	});
});
