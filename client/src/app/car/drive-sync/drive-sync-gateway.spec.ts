import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DriveSyncWireCommand } from './drive-sync.models';
import {
	DriveSyncGateway,
	driveSyncGatewayFailure,
	parseDriveSyncCollections,
	parseDriveSyncRemoteOutcome,
} from './drive-sync-gateway';

const operation = {
	operationId: 'operation',
	command: {
		type: 'drive.change',
		action: 'save',
		carId: 'car',
		sessionId: 'part',
		base: null,
		baseVersion: 1,
		input: {
			startedAt: '2026-10-09T12:00:00Z',
			durationMinutes: null,
			conditions: 'Dry',
			notes: '',
		},
	} satisfies DriveSyncWireCommand,
};
const collection = { carId: 'car', version: 1, sessions: [] };
const error = {
	code: 'BUILD_CONFLICT',
	message: 'Both versions retained.',
	details: { formErrors: ['Review'], fieldErrors: { name: ['Name'] } },
};

describe('DriveSyncGateway', () => {
	let gateway: DriveSyncGateway;
	let http: HttpTestingController;
	beforeEach(() => {
		TestBed.configureTestingModule({
			providers: [provideHttpClient(), provideHttpClientTesting()],
		});
		gateway = TestBed.inject(DriveSyncGateway);
		http = TestBed.inject(HttpTestingController);
	});
	afterEach(() => {
		http.verify();
		TestBed.resetTestingModule();
	});

	it('sends immutable intent with credentials and consumes acknowledged collections', async () => {
		const outcome = firstValueFrom(gateway.apply(operation));
		const request = http.expectOne('/api/v1/sync/operations/operation');
		expect(request.request.withCredentials).toBe(true);
		expect(request.request.body).toEqual({
			contractVersion: 1,
			command: operation.command,
		});
		request.flush({ operationId: 'operation', outcome: 'applied', collection });
		expect(await outcome).toEqual({
			operationId: 'operation',
			outcome: 'applied',
			collection,
		});
		expect(parseDriveSyncCollections({ collections: [collection] })).toEqual([
			collection,
		]);
		expect(() => parseDriveSyncCollections({ collections: null })).toThrow();
	});

	it.each(['rejected', 'conflict'] as const)(
		'retains canonical %s outcomes from HTTP errors',
		async (outcome) => {
			const promise = firstValueFrom(gateway.apply(operation));
			const response = {
				operationId: 'operation',
				outcome,
				error,
				...(outcome === 'conflict' ? { remote: collection } : {}),
			};
			http
				.expectOne('/api/v1/sync/operations/operation')
				.flush(response, { status: 409, statusText: 'Conflict' });
			expect(await promise).toEqual(response);
		},
	);

	it.each([
		{ operationId: 'other', outcome: 'applied', collection },
		{
			operationId: 'operation',
			outcome: 'applied',
			collection: { ...collection, carId: 'other' },
		},
		{
			operationId: 'operation',
			outcome: 'conflict',
			error,
			remote: { ...collection, carId: 'other' },
		},
		null,
	])('rejects invalid or misdirected responses', async (response) => {
		const promise = firstValueFrom(gateway.apply(operation));
		const rejected = expect(promise).rejects.toEqual({
			kind: 'invalid-response',
		});
		http.expectOne('/api/v1/sync/operations/operation').flush(response);
		await rejected;
	});

	it('classifies transport failures without treating them as acknowledgement', async () => {
		for (const status of [0, 401, 503]) {
			const promise = firstValueFrom(gateway.apply(operation));
			const rejected = expect(promise).rejects.toEqual(
				status === 401 ? { kind: 'http', status } : { kind: 'unavailable' },
			);
			const request = http.expectOne('/api/v1/sync/operations/operation');
			if (status === 0) request.error(new ProgressEvent('offline'));
			else
				request.flush(
					{ operationId: 'operation', outcome: 'applied', collection },
					{ status, statusText: 'Failed' },
				);
			await rejected;
		}
		expect(driveSyncGatewayFailure(new Error('unknown'))).toEqual({
			kind: 'unavailable',
		});
		expect(
			driveSyncGatewayFailure(new HttpErrorResponse({ status: 400 })),
		).toEqual({ kind: 'http', status: 400 });
		expect(() => parseDriveSyncRemoteOutcome({})).toThrow();
	});
});
