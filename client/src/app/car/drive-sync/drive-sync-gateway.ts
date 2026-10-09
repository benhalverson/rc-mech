import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { catchError, defer, map, type Observable, of, throwError } from 'rxjs';
import {
	array,
	literal,
	minLength,
	number,
	object,
	optional,
	record,
	string,
	union,
} from 'zod/mini';
import { CAR_SYNC_CONTRACT_VERSION } from '../../garage/car-sync/car-sync.models';
import { driveSessionSchema } from '../drive-sessions/drive-session.models';
import type {
	DriveSyncOperation,
	DriveSyncRemoteOutcome,
} from './drive-sync.models';

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

export const driveSyncCollectionSchema = object({
	carId: string(),
	version: number(),
	timezone: optional(string()),
	sessions: array(driveSessionSchema),
});

export const parseDriveSyncCollections = (value: unknown) =>
	object({ collections: array(driveSyncCollectionSchema) }).parse(value)
		.collections;

const driveSyncRemoteOutcomeSchema = union([
	object({
		operationId: string().check(minLength(1)),
		outcome: literal('applied'),
		collection: driveSyncCollectionSchema,
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
		remote: driveSyncCollectionSchema,
	}),
]);

/**
 * Marks schema/identity rejection separately from an HTTP outage, so malformed
 * acknowledgements cannot be accepted or mistaken for an offline retry signal.
 */
class InvalidDriveSyncResponse extends Error {}

export type DriveSyncGatewayFailure =
	| Readonly<{ kind: 'unavailable' }>
	| Readonly<{ kind: 'http'; status: number }>
	| Readonly<{ kind: 'invalid-response' }>;

export const parseDriveSyncRemoteOutcome = (
	value: unknown,
): DriveSyncRemoteOutcome => {
	const parsed = driveSyncRemoteOutcomeSchema.safeParse(value);
	if (!parsed.success) throw new InvalidDriveSyncResponse();
	return parsed.data;
};

export const driveSyncGatewayFailure = (
	error: unknown,
): DriveSyncGatewayFailure => {
	if (error instanceof HttpErrorResponse)
		return error.status === 0 || error.status >= 500
			? { kind: 'unavailable' }
			: { kind: 'http', status: error.status };
	return error instanceof InvalidDriveSyncResponse
		? { kind: 'invalid-response' }
		: { kind: 'unavailable' };
};

const recoverTerminalOutcome = (
	error: unknown,
): Observable<DriveSyncRemoteOutcome> => {
	if (error instanceof HttpErrorResponse && error.status !== 0) {
		const parsed = driveSyncRemoteOutcomeSchema.safeParse(error.error);
		if (
			parsed.success &&
			(parsed.data.outcome === 'rejected' || parsed.data.outcome === 'conflict')
		)
			return of(parsed.data);
	}
	return throwError(() => driveSyncGatewayFailure(error));
};

/**
 * Transports persisted Drive operations for CarWorkspaceStore and validates
 * canonical collections and outcomes before they enter the working copy. Stable
 * operation identities belong to the queue; this boundary owns URLs, credentials,
 * and transport-error classification, not retry scheduling.
 */
@Service()
export class DriveSyncGateway {
	private readonly http = inject(HttpClient);

	apply(
		operation: Pick<DriveSyncOperation, 'operationId' | 'command'>,
	): Observable<DriveSyncRemoteOutcome> {
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
			map(parseDriveSyncRemoteOutcome),
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
				return outcome;
			}),
		);
	}
}
