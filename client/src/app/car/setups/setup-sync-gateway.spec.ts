import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SetupSnapshot } from './setup-snapshot';
import type { SetupSyncOperation } from './setup-sync.models';
import {
	parseSetupSyncRemoteOutcome,
	SetupSyncGateway,
	setupSyncGatewayFailure,
} from './setup-sync-gateway';

const setup: SetupSnapshot = {
	id: 'setup-1',
	carId: 'car-1',
	name: 'Baseline',
	sections: {
		vehicle: {},
		drivetrain: {},
		electronics: {},
		tires: {},
		shocks: {},
		frontSuspension: {},
		rearSuspension: {},
		notes: {},
	},
	version: 2,
};

const operation: SetupSyncOperation = {
	operationId: 'operation/1',
	ownerKey: 'owner-1',
	carId: 'car-1',
	setupId: 'setup-1',
	command: {
		type: 'setup.select-current',
		carId: 'car-1',
		setupId: 'setup-1',
		baseCurrent: { setupId: null, version: 0 },
	},
	dependencies: [],
	status: 'pending',
	createdAt: '2026-08-11T10:00:00.000Z',
	sequence: 1,
};

describe('SetupSyncGateway', () => {
	let gateway: SetupSyncGateway;
	let http: HttpTestingController;

	beforeEach(() => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				SetupSyncGateway,
			],
		});
		gateway = TestBed.inject(SetupSyncGateway);
		http = TestBed.inject(HttpTestingController);
	});

	afterEach(() => {
		http.verify();
		TestBed.resetTestingModule();
	});

	it('applies a stable operation through the shared sync endpoint', async () => {
		const result = firstValueFrom(gateway.apply(operation));
		const request = http.expectOne('/api/v1/sync/operations/operation%2F1');
		expect(request.request.method).toBe('PUT');
		expect(request.request.withCredentials).toBe(true);
		expect(request.request.body).toEqual({
			contractVersion: 1,
			command: operation.command,
		});
		request.flush({
			operationId: 'operation/1',
			outcome: 'applied',
			setup,
			currentSetupId: 'setup-1',
			currentSetupVersion: 1,
		});
		await expect(result).resolves.toMatchObject({
			outcome: 'applied',
			setup: { id: 'setup-1' },
		});
	});

	it('retains terminal rejection and conflict responses from HTTP errors', async () => {
		const rejected = firstValueFrom(gateway.apply(operation));
		http.expectOne('/api/v1/sync/operations/operation%2F1').flush(
			{
				operationId: 'operation/1',
				outcome: 'rejected',
				error: { code: 'INVALID', message: 'Review this setup' },
			},
			{ status: 422, statusText: 'Unprocessable Entity' },
		);
		await expect(rejected).resolves.toMatchObject({ outcome: 'rejected' });

		const conflicted = firstValueFrom(gateway.apply(operation));
		http.expectOne('/api/v1/sync/operations/operation%2F1').flush(
			{
				operationId: 'operation/1',
				outcome: 'conflict',
				error: { code: 'CONFLICT', message: 'Current setup changed' },
				remote: {
					currentSetupId: null,
					currentSetupVersion: 3,
					setup: null,
				},
			},
			{ status: 409, statusText: 'Conflict' },
		);
		await expect(conflicted).resolves.toMatchObject({ outcome: 'conflict' });
	});

	it('classifies unavailable, HTTP, and malformed responses', async () => {
		const unavailable = firstValueFrom(gateway.apply(operation));
		http
			.expectOne('/api/v1/sync/operations/operation%2F1')
			.error(new ProgressEvent('network'));
		await expect(unavailable).rejects.toEqual({ kind: 'unavailable' });

		const server = firstValueFrom(gateway.apply(operation));
		http
			.expectOne('/api/v1/sync/operations/operation%2F1')
			.flush({}, { status: 503, statusText: 'Unavailable' });
		await expect(server).rejects.toEqual({ kind: 'unavailable' });

		const denied = firstValueFrom(gateway.apply(operation));
		http
			.expectOne('/api/v1/sync/operations/operation%2F1')
			.flush({}, { status: 403, statusText: 'Forbidden' });
		await expect(denied).rejects.toEqual({ kind: 'http', status: 403 });

		const malformed = firstValueFrom(gateway.apply(operation));
		http
			.expectOne('/api/v1/sync/operations/operation%2F1')
			.flush({ outcome: 'applied' });
		await expect(malformed).rejects.toEqual({ kind: 'invalid-response' });

		expect(setupSyncGatewayFailure(new Error('unknown'))).toEqual({
			kind: 'unavailable',
		});
		expect(() => parseSetupSyncRemoteOutcome({ outcome: 'nope' })).toThrow();
	});
});
