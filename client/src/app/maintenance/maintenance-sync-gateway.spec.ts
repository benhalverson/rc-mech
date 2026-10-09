import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tireRecord } from './consumables/consumable-sync.testing';
import { consumableChange } from './consumables/consumable-sync-rules';
import {
	maintenanceOperationFixture as operation,
	maintenanceRecordFixture as record,
	maintenanceSnapshotFixture as snapshot,
} from './maintenance-sync.testing';
import {
	MaintenanceSyncGateway,
	maintenanceSyncGatewayFailure,
	parseMaintenanceRemoteOutcome,
} from './maintenance-sync-gateway';

const collection = snapshot.collections[0];
const error = {
	code: 'BUILD_CONFLICT',
	message: 'Both versions retained.',
	details: { formErrors: ['Review'], fieldErrors: { name: ['Name'] } },
};

describe('MaintenanceSyncGateway', () => {
	let gateway: MaintenanceSyncGateway;
	let http: HttpTestingController;
	beforeEach(() => {
		TestBed.configureTestingModule({
			providers: [provideHttpClient(), provideHttpClientTesting()],
		});
		gateway = TestBed.inject(MaintenanceSyncGateway);
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
		expect(maintenanceSyncGatewayFailure(new Error('unknown'))).toEqual({
			kind: 'unavailable',
		});
		expect(
			maintenanceSyncGatewayFailure(new HttpErrorResponse({ status: 400 })),
		).toEqual({ kind: 'http', status: 400 });
		expect(() => parseMaintenanceRemoteOutcome({})).toThrow();
	});
	it('loads metadata and verifies service identities in acknowledgements', async () => {
		const result = firstValueFrom(gateway.load());
		http.expectOne('/api/v1/maintenance/sync/snapshot').flush(snapshot);
		expect(await result).toEqual(snapshot);
		const change = {
			...operation,
			command: {
				type: 'maintenance.change' as const,
				entity: 'service' as const,
				action: 'save' as const,
				carId: 'car',
				recordId: 'record',
				baseVersion: 1,
				base: null,
				planBase: null,
				baselineSessionCount: 2,
				input: {
					componentId: null,
					performedAt: record.performedAt,
					description: record.description,
					notes: null,
					cost: null,
					currency: null,
				},
			},
		};
		const applied = firstValueFrom(gateway.apply(change));
		http
			.expectOne('/api/v1/sync/operations/operation')
			.flush({ operationId: 'operation', outcome: 'applied', collection });
		expect(await applied).toMatchObject({ outcome: 'applied' });
		for (const candidate of [operation, change]) {
			const failure = firstValueFrom(gateway.apply(candidate));
			const rejected = expect(failure).rejects.toEqual({
				kind: 'invalid-response',
			});
			http.expectOne('/api/v1/sync/operations/operation').flush({
				operationId: 'operation',
				outcome: 'applied',
				collection: { ...collection, plans: [], records: [] },
			});
			await rejected;
		}
	});
	it('accepts only acknowledgements containing the expected Consumable identity', async () => {
		const command = consumableChange(
			{
				kind: 'change',
				action: 'archive',
				entry: {
					id: 'tire',
					carId: 'car',
					kind: 'tires',
					performedAt: tireRecord.performedAt,
				},
			},
			[tireRecord],
			'unused',
			1,
		);
		for (const consumables of [
			undefined,
			[],
			[{ ...tireRecord, id: 'other' }],
			[tireRecord],
		]) {
			const promise = firstValueFrom(gateway.apply({ ...operation, command }));
			const check =
				consumables?.[0]?.id === 'tire'
					? expect(promise).resolves.toMatchObject({ outcome: 'applied' })
					: expect(promise).rejects.toEqual({ kind: 'invalid-response' });
			http.expectOne('/api/v1/sync/operations/operation').flush({
				operationId: 'operation',
				outcome: 'applied',
				collection: { ...collection, consumables },
			});
			await check;
		}
	});
});
