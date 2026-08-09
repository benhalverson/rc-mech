import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	driveSessionGatewayFailure,
	DriveSessionGateway,
	parseDriveSessionCollection,
	parseDriveSessionMutation,
	parseDriveSessionTimezone,
} from './drive-session-gateway';

const session = {
	id: 'drive-1',
	carId: 'car-1',
	startedAt: '2026-08-08T01:00:00.000Z',
};

describe('DriveSessionGateway', () => {
	let gateway: DriveSessionGateway;
	let http: HttpTestingController;

	beforeEach(() => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				DriveSessionGateway,
			],
		});
		gateway = TestBed.inject(DriveSessionGateway);
		http = TestBed.inject(HttpTestingController);
	});

	afterEach(() => {
		http.verify();
		TestBed.resetTestingModule();
	});

	it('parses canonical and legacy collections into one model', () => {
		expect(
			parseDriveSessionCollection({
				driveSessions: [session],
				sessions: [{ ...session, id: 'legacy' }],
				timezone: 'UTC',
			}),
		).toEqual({
			sessions: [
				{
					...session,
					durationMinutes: null,
					conditions: null,
					notes: null,
					deletedAt: null,
				},
			],
			timezone: 'UTC',
		});
		expect(
			parseDriveSessionCollection({ sessions: [session] }).sessions,
		).toHaveLength(1);
		expect(parseDriveSessionCollection({})).toEqual({
			sessions: [],
			timezone: null,
		});
		expect(() => parseDriveSessionCollection({ driveSessions: [42] })).toThrow(
			'invalid',
		);
	});

	it('parses mutation and timezone responses', () => {
		expect(parseDriveSessionMutation({ driveSession: session })).toMatchObject(
			session,
		);
		expect(parseDriveSessionTimezone({})).toEqual({ timezone: null });
		expect(parseDriveSessionTimezone({ timezone: 'UTC' })).toEqual({
			timezone: 'UTC',
		});
		expect(() => parseDriveSessionMutation({ status: true })).toThrow(
			'invalid',
		);
	});

	it('maps transport, server, parser, and unknown failures', () => {
		expect(
			driveSessionGatewayFailure(new HttpErrorResponse({ status: 0 })),
		).toEqual({ kind: 'unavailable' });
		expect(
			driveSessionGatewayFailure(
				new HttpErrorResponse({
					status: 409,
					error: { error: 'Drive session is immutable.' },
				}),
			),
		).toEqual({
			kind: 'rejected-response',
			status: 409,
			message: 'Drive session is immutable.',
		});
		expect(
			driveSessionGatewayFailure(new HttpErrorResponse({ status: 503 })),
		).toEqual({ kind: 'http', status: 503 });
		let parserError: unknown;
		try {
			parseDriveSessionMutation({});
		} catch (error) {
			parserError = error;
		}
		expect(driveSessionGatewayFailure(parserError)).toEqual({
			kind: 'invalid-response',
		});
		expect(driveSessionGatewayFailure('offline')).toEqual({
			kind: 'unavailable',
		});
	});

	it('owns authenticated reads, compatibility parsing, and refresh', async () => {
		expect(gateway.collectionFailure()).toBeNull();
		gateway.selectCar('car/one');
		gateway.selectCar('car/one');
		let collection: ReturnType<HttpTestingController['expectOne']> | undefined;
		let timezone: ReturnType<HttpTestingController['expectOne']> | undefined;
		await vi.waitFor(() => {
			collection = http.expectOne('/api/v1/cars/car%2Fone/drives?history=true');
			timezone = http.expectOne('/api/v1/preferences/timezone');
		});
		if (!collection || !timezone)
			throw new Error('Gateway reads were not issued.');
		expect(collection.request.withCredentials).toBe(true);
		expect(timezone.request.withCredentials).toBe(true);
		collection.flush({ sessions: [session] });
		timezone.flush({});
		await vi.waitFor(() => {
			expect(gateway.collection.value()?.sessions).toHaveLength(1);
			expect(gateway.timezone.value()).toEqual({ timezone: null });
		});

		gateway.refresh();
		await vi.waitFor(() =>
			http
				.expectOne('/api/v1/cars/car%2Fone/drives?history=true')
				.flush({ driveSessions: [] }),
		);
	});

	it('issues cold create, update, and archive mutations', async () => {
		const draft = {
			startedAt: session.startedAt,
			durationMinutes: null,
			conditions: 'Dry',
			notes: 'Fast',
		};
		const createResult = firstValueFrom(
			gateway.saveDriveSession({ carId: 'car/one', sessionId: null, draft }),
		);
		let request = http.expectOne('/api/v1/cars/car%2Fone/drives');
		expect(request.request.method).toBe('POST');
		expect(request.request.withCredentials).toBe(true);
		expect(request.request.body).toEqual(draft);
		request.flush({ driveSession: session });
		await expect(createResult).resolves.toMatchObject(session);

		const updateResult = firstValueFrom(
			gateway.saveDriveSession({
				carId: 'car/one',
				sessionId: 'drive/one',
				draft,
			}),
		);
		request = http.expectOne('/api/v1/cars/car%2Fone/drives/drive%2Fone');
		expect(request.request.method).toBe('PATCH');
		request.flush({ driveSession: session });
		await expect(updateResult).resolves.toMatchObject(session);

		const archiveResult = firstValueFrom(
			gateway.archiveDriveSession({
				carId: 'car/one',
				sessionId: 'drive/one',
			}),
		);
		request = http.expectOne('/api/v1/cars/car%2Fone/drives/drive%2Fone');
		expect(request.request.method).toBe('DELETE');
		expect(request.request.withCredentials).toBe(true);
		request.flush({ driveSession: { ...session, deletedAt: 'now' } });
		await expect(archiveResult).resolves.toMatchObject({ deletedAt: 'now' });
	});

	it('maps invalid and rejected mutation responses', async () => {
		const draft = {
			startedAt: session.startedAt,
			durationMinutes: null,
			conditions: '',
			notes: '',
		};
		let result = firstValueFrom(
			gateway.saveDriveSession({ carId: 'car-1', sessionId: null, draft }),
		);
		http.expectOne('/api/v1/cars/car-1/drives').flush({ status: true });
		await expect(result).rejects.toEqual({ kind: 'invalid-response' });

		result = firstValueFrom(
			gateway.saveDriveSession({ carId: 'car-1', sessionId: null, draft }),
		);
		http
			.expectOne('/api/v1/cars/car-1/drives')
			.flush(
				{ error: 'Car is archived.' },
				{ status: 409, statusText: 'Conflict' },
			);
		await expect(result).rejects.toEqual({
			kind: 'rejected-response',
			status: 409,
			message: 'Car is archived.',
		});
	});
});
