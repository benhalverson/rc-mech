import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	parseTimezonePreference,
	timezoneGatewayFailure,
	TimezoneGateway,
} from './timezone-gateway';

describe('TimezoneGateway', () => {
	let gateway: TimezoneGateway;
	let http: HttpTestingController;

	beforeEach(() => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				TimezoneGateway,
			],
		});
		gateway = TestBed.inject(TimezoneGateway);
		http = TestBed.inject(HttpTestingController);
	});

	afterEach(() => {
		http.verify();
		TestBed.resetTestingModule();
	});

	it('parses canonical, missing, and malformed responses', () => {
		expect(parseTimezonePreference({ timezone: 'UTC' })).toEqual({
			timezone: 'UTC',
		});
		expect(parseTimezonePreference({})).toEqual({ timezone: null });
		expect(parseTimezonePreference({ timezone: null })).toEqual({
			timezone: null,
		});
		expect(() => parseTimezonePreference({ timezone: 42 })).toThrow('invalid');
	});

	it('maps every transport failure category', () => {
		expect(
			timezoneGatewayFailure(new HttpErrorResponse({ status: 0 })),
		).toMatchObject({ kind: 'unavailable' });
		expect(
			timezoneGatewayFailure(new HttpErrorResponse({ status: 422 })),
		).toMatchObject({ kind: 'http', status: 422 });
		expect(
			timezoneGatewayFailure(new Error('The timezone response was invalid.')),
		).toMatchObject({ kind: 'invalid-response' });
		expect(timezoneGatewayFailure('rejected')).toMatchObject({
			kind: 'rejected-response',
		});
	});

	it('owns authenticated read and mutation transport', async () => {
		gateway.preference.value();
		let read: ReturnType<HttpTestingController['expectOne']> | undefined;
		await vi.waitFor(() => {
			read = http.expectOne('/api/v1/preferences/timezone');
		});
		if (!read) throw new Error('The timezone read was not issued.');
		expect(read.request.withCredentials).toBe(true);
		read.flush({ timezone: 'America/Los_Angeles' });

		gateway.saveTimezone({ timezone: 'UTC' }).subscribe((value) => {
			expect(value).toEqual({ timezone: 'UTC' });
		});
		const mutation = http.expectOne('/api/v1/preferences/timezone');
		expect(mutation.request.method).toBe('PATCH');
		expect(mutation.request.withCredentials).toBe(true);
		expect(mutation.request.body).toEqual({ timezone: 'UTC' });
		mutation.flush({ timezone: 'UTC' });

		gateway.refresh();
	});

	it('maps invalid mutation responses through the cold Observable', () => {
		gateway.saveTimezone({ timezone: 'UTC' }).subscribe({
			error: (error: unknown) =>
				expect(error).toMatchObject({ kind: 'invalid-response' }),
		});
		http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 42 });
	});
});
