import {
	HttpClient,
	HttpErrorResponse,
	provideHttpClient,
	withInterceptors,
} from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ownerSessionExpiryInterceptor } from './owner-session-expiry.interceptor';
import { OwnerSessionStore } from './owner-session-store';

describe('ownerSessionExpiryInterceptor', () => {
	let http: HttpClient;
	let controller: HttpTestingController;
	const sessionStore = { expire: vi.fn() };
	const router = {
		url: '/garage/car-1/photos',
		navigate: vi.fn(async () => true),
	};

	beforeEach(() => {
		sessionStore.expire.mockClear();
		router.navigate.mockClear();
		router.url = '/garage/car-1/photos';
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(withInterceptors([ownerSessionExpiryInterceptor])),
				provideHttpClientTesting(),
				{ provide: OwnerSessionStore, useValue: sessionStore },
				{ provide: Router, useValue: router },
			],
		});
		http = TestBed.inject(HttpClient);
		controller = TestBed.inject(HttpTestingController);
	});

	afterEach(() => {
		controller.verify();
		TestBed.resetTestingModule();
	});

	it('expires the shared session and returns protected API failures to sign-in', () => {
		let receivedError: HttpErrorResponse | undefined;
		http.get('/api/v1/cars').subscribe({
			error: (error: HttpErrorResponse) => {
				receivedError = error;
			},
		});
		controller
			.expectOne('/api/v1/cars')
			.flush({}, { status: 401, statusText: 'Unauthorized' });

		expect(receivedError?.status).toBe(401);
		expect(sessionStore.expire).toHaveBeenCalledTimes(1);
		expect(router.navigate).toHaveBeenCalledWith(['/sign-in'], {
			queryParams: {
				returnTo: '/garage/car-1/photos',
				reason: 'session-expired',
			},
		});
	});

	it('does not treat an authentication ceremony failure as session expiry', () => {
		http
			.get('/api/auth/passkey/generate-register-options')
			.subscribe({ error: () => undefined });
		controller
			.expectOne('/api/auth/passkey/generate-register-options')
			.flush({}, { status: 401, statusText: 'Unauthorized' });

		expect(sessionStore.expire).not.toHaveBeenCalled();
		expect(router.navigate).not.toHaveBeenCalled();
	});

	it('falls back to Garage when the current router URL is not absolute', () => {
		router.url = 'not-yet-navigated';
		http.get('/api/v1/cars').subscribe({ error: () => undefined });
		controller
			.expectOne('/api/v1/cars')
			.flush({}, { status: 401, statusText: 'Unauthorized' });

		expect(router.navigate).toHaveBeenCalledWith(['/sign-in'], {
			queryParams: {
				returnTo: '/garage',
				reason: 'session-expired',
			},
		});
	});
});
