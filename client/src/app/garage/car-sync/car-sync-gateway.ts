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
import { garageCarSchema } from '../garage.models';
import {
	CAR_SYNC_CONTRACT_VERSION,
	type CarSyncOperation,
	type CarSyncRemoteOutcome,
} from './car-sync.models';

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

const carSyncRemoteOutcomeSchema = union([
	object({
		operationId: string().check(minLength(1)),
		outcome: literal('applied'),
		car: garageCarSchema,
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
		remote: object({ car: garageCarSchema }),
	}),
]);

class InvalidCarSyncResponse extends Error {}

export type CarSyncGatewayFailure =
	| Readonly<{ kind: 'unavailable' }>
	| Readonly<{ kind: 'http'; status: number }>
	| Readonly<{ kind: 'invalid-response' }>;

export const parseCarSyncRemoteOutcome = (
	value: unknown,
): CarSyncRemoteOutcome => {
	const parsed = carSyncRemoteOutcomeSchema.safeParse(value);
	if (!parsed.success) throw new InvalidCarSyncResponse();
	return parsed.data;
};

export const carSyncGatewayFailure = (
	error: unknown,
): CarSyncGatewayFailure => {
	if (error instanceof HttpErrorResponse)
		return error.status === 0 || error.status >= 500
			? { kind: 'unavailable' }
			: { kind: 'http', status: error.status };
	return error instanceof InvalidCarSyncResponse
		? { kind: 'invalid-response' }
		: { kind: 'unavailable' };
};

const recoverTerminalOutcome = (
	error: unknown,
): Observable<CarSyncRemoteOutcome> => {
	if (error instanceof HttpErrorResponse && error.status !== 0) {
		const parsed = carSyncRemoteOutcomeSchema.safeParse(error.error);
		if (
			parsed.success &&
			(parsed.data.outcome === 'rejected' || parsed.data.outcome === 'conflict')
		)
			return of(parsed.data);
	}
	return throwError(() => carSyncGatewayFailure(error));
};

@Service()
export class CarSyncGateway {
	private readonly http = inject(HttpClient);

	apply(
		operation: Pick<CarSyncOperation, 'operationId' | 'command'>,
	): Observable<CarSyncRemoteOutcome> {
		return defer(() =>
			this.http.put<unknown>(
				`/api/v1/sync/operations/${encodeURIComponent(operation.operationId)}`,
				{
					contractVersion: CAR_SYNC_CONTRACT_VERSION,
					command: operation.command,
				},
				{ withCredentials: true },
			),
		).pipe(map(parseCarSyncRemoteOutcome), catchError(recoverTerminalOutcome));
	}
}
