import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GarageCar } from '../garage.models';
import type { CarSyncOperation } from './car-sync.models';
import {
	CarSyncGateway,
	carSyncGatewayFailure,
	parseCarSyncRemoteOutcome,
} from './car-sync-gateway';

const car = (overrides: Partial<GarageCar> = {}): GarageCar => ({
	id: 'car-1',
	name: 'B7 carpet',
	make: 'Associated',
	archivedAt: null,
	createdAt: '2026-08-11T10:00:00.000Z',
	version: 4,
	...overrides,
});

const operation = (
	overrides: Partial<CarSyncOperation> = {},
): CarSyncOperation => ({
	operationId: 'operation/one?#',
	ownerKey: 'owner-1',
	carId: 'car-1',
	command: {
		type: 'car.edit',
		carId: 'car-1',
		baseVersion: 3,
		base: { name: 'B7 carpet' },
		changes: { name: 'B7 club' },
	},
	dependencies: [],
	status: 'pending',
	createdAt: '2026-08-11T10:01:00.000Z',
	...overrides,
});

describe('CarSyncGateway', () => {
	let gateway: CarSyncGateway;
	let http: HttpTestingController;

	beforeEach(() => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				CarSyncGateway,
			],
		});
		gateway = TestBed.inject(CarSyncGateway);
		http = TestBed.inject(HttpTestingController);
	});

	afterEach(() => {
		http.verify();
		TestBed.resetTestingModule();
	});

	it('validates each terminal server outcome without losing feedback', () => {
		const feedback = {
			code: 'CAR_VALIDATION_FAILED',
			message: 'Car change needs attention',
			details: {
				formErrors: ['Review this Car'],
				fieldErrors: { name: ['Enter a name'], notes: ['Too long'] },
			},
		};
		expect(
			parseCarSyncRemoteOutcome({
				operationId: 'operation-applied',
				outcome: 'applied',
				car: car(),
			}),
		).toEqual({
			operationId: 'operation-applied',
			outcome: 'applied',
			car: car(),
		});
		expect(
			parseCarSyncRemoteOutcome({
				operationId: 'operation-rejected',
				outcome: 'rejected',
				error: feedback,
			}),
		).toEqual({
			operationId: 'operation-rejected',
			outcome: 'rejected',
			error: feedback,
		});
		expect(
			parseCarSyncRemoteOutcome({
				operationId: 'operation-conflict',
				outcome: 'conflict',
				error: feedback,
				remote: { car: car({ name: 'Remote name', version: 5 }) },
			}),
		).toEqual({
			operationId: 'operation-conflict',
			outcome: 'conflict',
			error: feedback,
			remote: { car: car({ name: 'Remote name', version: 5 }) },
		});

		expect(() =>
			parseCarSyncRemoteOutcome({
				operationId: 'operation-bad',
				outcome: 'applied',
				car: { id: 7, name: 'Bad Car' },
			}),
		).toThrow();
		expect(() =>
			parseCarSyncRemoteOutcome({
				operationId: 'operation-bad',
				outcome: 'conflict',
				error: { code: 'CONFLICT' },
				remote: { car: car() },
			}),
		).toThrow();
	});

	it('sends a cold authenticated PUT with a URL-safe operation ID', async () => {
		const pending = gateway.apply(operation());
		http.expectNone('/api/v1/sync/operations/operation%2Fone%3F%23');

		const result = firstValueFrom(pending);
		const request = http.expectOne(
			'/api/v1/sync/operations/operation%2Fone%3F%23',
		);
		expect(request.request.method).toBe('PUT');
		expect(request.request.withCredentials).toBe(true);
		expect(request.request.body).toEqual({
			contractVersion: 1,
			command: operation().command,
		});
		request.flush({
			operationId: operation().operationId,
			outcome: 'applied',
			car: car(),
		});

		await expect(result).resolves.toEqual({
			operationId: operation().operationId,
			outcome: 'applied',
			car: car(),
		});
	});

	it('emits durable validation and conflict outcomes returned with HTTP errors', async () => {
		const feedback = {
			code: 'CAR_VALIDATION_FAILED',
			message: 'Car change needs attention',
			details: { fieldErrors: { name: ['Enter a name'] } },
		};
		const rejected = firstValueFrom(gateway.apply(operation()));
		http.expectOne('/api/v1/sync/operations/operation%2Fone%3F%23').flush(
			{
				operationId: operation().operationId,
				outcome: 'rejected',
				error: feedback,
			},
			{ status: 422, statusText: 'Unprocessable Content' },
		);
		await expect(rejected).resolves.toEqual({
			operationId: operation().operationId,
			outcome: 'rejected',
			error: feedback,
		});

		const conflict = firstValueFrom(gateway.apply(operation()));
		http.expectOne('/api/v1/sync/operations/operation%2Fone%3F%23').flush(
			{
				operationId: operation().operationId,
				outcome: 'conflict',
				error: {
					code: 'CAR_SYNC_CONFLICT',
					message: 'Car changes conflict',
				},
				remote: { car: car({ name: 'Remote name', version: 5 }) },
			},
			{ status: 409, statusText: 'Conflict' },
		);
		await expect(conflict).resolves.toEqual({
			operationId: operation().operationId,
			outcome: 'conflict',
			error: {
				code: 'CAR_SYNC_CONFLICT',
				message: 'Car changes conflict',
			},
			remote: { car: car({ name: 'Remote name', version: 5 }) },
		});
	});

	it('maps network, HTTP, and malformed responses to typed failures', async () => {
		expect(carSyncGatewayFailure(new HttpErrorResponse({ status: 0 }))).toEqual(
			{ kind: 'unavailable' },
		);
		expect(
			carSyncGatewayFailure(new HttpErrorResponse({ status: 503 })),
		).toEqual({ kind: 'unavailable' });
		expect(
			carSyncGatewayFailure(new HttpErrorResponse({ status: 401 })),
		).toEqual({ kind: 'http', status: 401 });
		expect(carSyncGatewayFailure('offline')).toEqual({ kind: 'unavailable' });

		let malformedError: unknown;
		try {
			parseCarSyncRemoteOutcome({ outcome: 'applied', car: null });
		} catch (error) {
			malformedError = error;
		}
		expect(carSyncGatewayFailure(malformedError)).toEqual({
			kind: 'invalid-response',
		});

		const unavailable = firstValueFrom(gateway.apply(operation()));
		http
			.expectOne('/api/v1/sync/operations/operation%2Fone%3F%23')
			.error(new ProgressEvent('offline'));
		await expect(unavailable).rejects.toEqual({ kind: 'unavailable' });

		const httpFailure = firstValueFrom(gateway.apply(operation()));
		http
			.expectOne('/api/v1/sync/operations/operation%2Fone%3F%23')
			.flush(
				{ error: { code: 'OPERATION_ID_REUSED', message: 'Already used' } },
				{ status: 409, statusText: 'Conflict' },
			);
		await expect(httpFailure).rejects.toEqual({ kind: 'http', status: 409 });

		const malformed = firstValueFrom(gateway.apply(operation()));
		http
			.expectOne('/api/v1/sync/operations/operation%2Fone%3F%23')
			.flush({ operationId: operation().operationId, outcome: 'applied' });
		await expect(malformed).rejects.toEqual({ kind: 'invalid-response' });
	});
});
