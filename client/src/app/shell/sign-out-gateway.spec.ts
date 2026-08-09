import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	parseSignOutResponse,
	SignOutGateway,
	signOutGatewayFailure,
} from './sign-out-gateway';

describe('SignOutGateway', () => {
	let gateway: SignOutGateway;
	let http: HttpTestingController;

	beforeEach(() => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				SignOutGateway,
			],
		});
		gateway = TestBed.inject(SignOutGateway);
		http = TestBed.inject(HttpTestingController);
	});

	afterEach(() => {
		http.verify();
		TestBed.resetTestingModule();
	});

	it('posts to the sign-out endpoint with credentials and parses success', async () => {
		const result = firstValueFrom(gateway.signOut());
		const request = http.expectOne('/api/auth/sign-out');
		expect(request.request.method).toBe('POST');
		expect(request.request.withCredentials).toBe(true);
		expect(request.request.body).toEqual({});
		request.flush({ success: true });
		expect(await result).toEqual({ success: true });
	});

	it('maps malformed and unavailable responses to canonical failures', async () => {
		const malformed = firstValueFrom(gateway.signOut());
		http.expectOne('/api/auth/sign-out').flush({ success: false });
		await expect(malformed).rejects.toEqual({ kind: 'invalid-response' });

		const unavailable = firstValueFrom(gateway.signOut());
		http.expectOne('/api/auth/sign-out').error(new ProgressEvent('offline'));
		await expect(unavailable).rejects.toEqual({ kind: 'unavailable' });
	});

	it('maps HTTP and unknown failures without exposing transport errors', async () => {
		const result = firstValueFrom(gateway.signOut());
		http
			.expectOne('/api/auth/sign-out')
			.flush('nope', { status: 503, statusText: 'Unavailable' });
		await expect(result).rejects.toEqual({ kind: 'http', status: 503 });
		expect(signOutGatewayFailure(new Error('unexpected'))).toEqual({
			kind: 'unavailable',
		});
	});

	it('rejects values outside the sign-out response contract', () => {
		expect(() => parseSignOutResponse(null)).toThrow();
	});
});
