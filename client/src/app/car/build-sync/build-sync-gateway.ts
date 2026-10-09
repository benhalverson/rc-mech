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
import { installedComponentSchema } from '../car.models';
import type {
	BuildSyncOperation,
	BuildSyncRemoteOutcome,
} from './build-sync.models';

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

export const buildSyncCollectionSchema = object({
	carId: string(),
	version: number(),
	components: array(installedComponentSchema),
});

export const parseBuildSyncCollections = (value: unknown) =>
	object({ collections: array(buildSyncCollectionSchema) }).parse(value)
		.collections;

const buildSyncRemoteOutcomeSchema = union([
	object({
		operationId: string().check(minLength(1)),
		outcome: literal('applied'),
		collection: buildSyncCollectionSchema,
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
		remote: buildSyncCollectionSchema,
	}),
]);

class InvalidBuildSyncResponse extends Error {}

export type BuildSyncGatewayFailure =
	| Readonly<{ kind: 'unavailable' }>
	| Readonly<{ kind: 'http'; status: number }>
	| Readonly<{ kind: 'invalid-response' }>;

export const parseBuildSyncRemoteOutcome = (
	value: unknown,
): BuildSyncRemoteOutcome => {
	const parsed = buildSyncRemoteOutcomeSchema.safeParse(value);
	if (!parsed.success) throw new InvalidBuildSyncResponse();
	return parsed.data;
};

export const buildSyncGatewayFailure = (
	error: unknown,
): BuildSyncGatewayFailure => {
	if (error instanceof HttpErrorResponse)
		return error.status === 0 || error.status >= 500
			? { kind: 'unavailable' }
			: { kind: 'http', status: error.status };
	return error instanceof InvalidBuildSyncResponse
		? { kind: 'invalid-response' }
		: { kind: 'unavailable' };
};

const recoverTerminalOutcome = (
	error: unknown,
): Observable<BuildSyncRemoteOutcome> => {
	if (error instanceof HttpErrorResponse && error.status !== 0) {
		const parsed = buildSyncRemoteOutcomeSchema.safeParse(error.error);
		if (
			parsed.success &&
			(parsed.data.outcome === 'rejected' || parsed.data.outcome === 'conflict')
		)
			return of(parsed.data);
	}
	return throwError(() => buildSyncGatewayFailure(error));
};

@Service()
export class BuildSyncGateway {
	private readonly http = inject(HttpClient);

	apply(
		operation: Pick<BuildSyncOperation, 'operationId' | 'command'>,
	): Observable<BuildSyncRemoteOutcome> {
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
			map(parseBuildSyncRemoteOutcome),
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
