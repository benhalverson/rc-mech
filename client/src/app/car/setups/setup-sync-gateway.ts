import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { catchError, defer, map, type Observable, of, throwError } from 'rxjs';
import {
	array,
	literal,
	minLength,
	nullable,
	number,
	object,
	optional,
	record,
	string,
	union,
} from 'zod/mini';
import { CAR_SYNC_CONTRACT_VERSION } from '../../garage/car-sync/car-sync.models';
import { setupSnapshotSchema } from './setup-snapshot';
import type {
	SetupSyncOperation,
	SetupSyncRemoteOutcome,
} from './setup-sync.models';

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

const selectionFields = {
	currentSetupId: nullable(string()),
	currentSetupVersion: number(),
};

const setupSyncRemoteOutcomeSchema = union([
	object({
		operationId: string().check(minLength(1)),
		outcome: literal('applied'),
		setup: setupSnapshotSchema,
		...selectionFields,
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
		remote: object({
			...selectionFields,
			setup: nullable(setupSnapshotSchema),
		}),
	}),
]);

class InvalidSetupSyncResponse extends Error {}

export type SetupSyncGatewayFailure =
	| Readonly<{ kind: 'unavailable' }>
	| Readonly<{ kind: 'http'; status: number }>
	| Readonly<{ kind: 'invalid-response' }>;

export const parseSetupSyncRemoteOutcome = (
	value: unknown,
): SetupSyncRemoteOutcome => {
	const parsed = setupSyncRemoteOutcomeSchema.safeParse(value);
	if (!parsed.success) throw new InvalidSetupSyncResponse();
	return parsed.data;
};

export const setupSyncGatewayFailure = (
	error: unknown,
): SetupSyncGatewayFailure => {
	if (error instanceof HttpErrorResponse)
		return error.status === 0 || error.status >= 500
			? { kind: 'unavailable' }
			: { kind: 'http', status: error.status };
	return error instanceof InvalidSetupSyncResponse
		? { kind: 'invalid-response' }
		: { kind: 'unavailable' };
};

const recoverTerminalOutcome = (
	error: unknown,
): Observable<SetupSyncRemoteOutcome> => {
	if (error instanceof HttpErrorResponse && error.status !== 0) {
		const parsed = setupSyncRemoteOutcomeSchema.safeParse(error.error);
		if (
			parsed.success &&
			(parsed.data.outcome === 'rejected' || parsed.data.outcome === 'conflict')
		)
			return of(parsed.data);
	}
	return throwError(() => setupSyncGatewayFailure(error));
};

@Service()
export class SetupSyncGateway {
	private readonly http = inject(HttpClient);

	apply(
		operation: Pick<SetupSyncOperation, 'operationId' | 'command'>,
	): Observable<SetupSyncRemoteOutcome> {
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
			map(parseSetupSyncRemoteOutcome),
			catchError(recoverTerminalOutcome),
		);
	}
}
