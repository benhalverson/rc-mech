import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { catchError, defer, map, type Observable, of, throwError } from 'rxjs';
import {
	array,
	literal,
	minLength,
	object,
	optional,
	record,
	string,
	union,
} from 'zod/mini';
import { CAR_SYNC_CONTRACT_VERSION } from '../garage/car-sync/car-sync.models';
import type {
	MaintenanceOperation,
	MaintenanceRemoteOutcome,
} from './maintenance-sync.models';
import {
	maintenanceCollectionSchema,
	maintenanceSnapshotSchema,
} from './maintenance-sync-schema';

const feedbackSchema = object({
	code: string().check(minLength(1)),
	message: string().check(minLength(1)),
	details: optional(
		object({
			formErrors: optional(array(string())),
			fieldErrors: optional(record(string(), array(string()))),
		}),
	),
});

const maintenanceSyncRemoteOutcomeSchema = union([
	object({
		operationId: string().check(minLength(1)),
		outcome: literal('applied'),
		collection: maintenanceCollectionSchema,
	}),
	object({
		operationId: string().check(minLength(1)),
		outcome: literal('rejected'),
		error: feedbackSchema,
	}),
	object({
		operationId: string().check(minLength(1)),
		outcome: literal('conflict'),
		error: feedbackSchema,
		remote: maintenanceCollectionSchema,
	}),
]);

/**
 * Marks schema/identity rejection separately from an HTTP outage, so malformed
 * acknowledgements cannot be accepted or mistaken for an offline retry signal.
 */
class InvalidMaintenanceSyncResponse extends Error {}

export type MaintenanceSyncGatewayFailure =
	| Readonly<{ kind: 'unavailable' }>
	| Readonly<{ kind: 'http'; status: number }>
	| Readonly<{ kind: 'invalid-response' }>;

export const parseMaintenanceRemoteOutcome = (
	value: unknown,
): MaintenanceRemoteOutcome => {
	const parsed = maintenanceSyncRemoteOutcomeSchema.safeParse(value);
	if (!parsed.success) throw new InvalidMaintenanceSyncResponse();
	return parsed.data;
};

export const maintenanceSyncGatewayFailure = (
	error: unknown,
): MaintenanceSyncGatewayFailure => {
	if (error instanceof HttpErrorResponse)
		return error.status === 0 || error.status >= 500
			? { kind: 'unavailable' }
			: { kind: 'http', status: error.status };
	return error instanceof InvalidMaintenanceSyncResponse
		? { kind: 'invalid-response' }
		: { kind: 'unavailable' };
};

const recoverTerminalOutcome = (
	error: unknown,
): Observable<MaintenanceRemoteOutcome> => {
	if (error instanceof HttpErrorResponse && error.status !== 0) {
		const parsed = maintenanceSyncRemoteOutcomeSchema.safeParse(error.error);
		if (
			parsed.success &&
			(parsed.data.outcome === 'rejected' || parsed.data.outcome === 'conflict')
		)
			return of(parsed.data);
	}
	return throwError(() => maintenanceSyncGatewayFailure(error));
};

/**
 * HTTP boundary for the root Maintenance workspace's snapshots and durable
 * operations. Validates operation/Car identity and canonical conflict evidence
 * before acknowledgement; it owns neither local baselines nor replay ordering.
 */
@Service()
export class MaintenanceSyncGateway {
	private readonly http = inject(HttpClient);
	load() {
		return this.http
			.get<unknown>('/api/v1/maintenance/sync/snapshot', {
				withCredentials: true,
			})
			.pipe(map((value) => maintenanceSnapshotSchema.parse(value)));
	}

	apply(
		operation: Pick<MaintenanceOperation, 'operationId' | 'command'>,
	): Observable<MaintenanceRemoteOutcome> {
		return defer(() =>
			this.http.put<unknown>(
				`/api/v1/sync/operations/${encodeURIComponent(operation.operationId)}`,
				{
					contractVersion: CAR_SYNC_CONTRACT_VERSION,
					command: operation.command,
				},
				{ withCredentials: true },
			),
		).pipe(
			map(parseMaintenanceRemoteOutcome),
			catchError(recoverTerminalOutcome),
			map((outcome) => {
				if (
					outcome.operationId !== operation.operationId ||
					(outcome.outcome === 'applied' &&
						outcome.collection.carId !== operation.command.carId) ||
					(outcome.outcome === 'conflict' &&
						outcome.remote.carId !== operation.command.carId)
				)
					throw { kind: 'invalid-response' };
				const command = operation.command;
				if (
					outcome.outcome === 'applied' &&
					!(command.entity === 'consumable'
						? outcome.collection.consumables?.some(
								(entry) => entry.id === command.entryId,
							)
						: command.entity === 'plan'
							? outcome.collection.plans.some(
									(plan) => plan.id === command.planId,
								)
							: outcome.collection.records.some(
									(record) => record.id === command.recordId,
								))
				)
					throw { kind: 'invalid-response' };
				return outcome;
			}),
		);
	}
}
