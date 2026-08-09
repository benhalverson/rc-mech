import {
	HttpClient,
	HttpErrorResponse,
	httpResource,
} from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { catchError, map, throwError, type Observable } from 'rxjs';
import { minLength, object, safeParse, string, trim } from 'zod/mini';
import type * as z from 'zod/mini';
import {
	type ArchiveDriveSessionCommand,
	type DriveSession,
	type DriveSessionCollection,
	driveSessionCollectionSchema,
	type DriveSessionGatewayFailure,
	driveSessionMutationSchema,
	driveSessionTimezoneSchema,
	type SaveDriveSessionCommand,
} from './drive-session.models';

const apiErrorSchema = object({
	error: string().check(trim(), minLength(1)),
});

class InvalidDriveSessionResponse extends Error {}

const parse = <T>(schema: z.core.$ZodType<T>, value: unknown): T => {
	const result = safeParse(schema, value);
	if (!result.success)
		throw new InvalidDriveSessionResponse(
			'The drive session response was invalid.',
		);
	return result.data;
};

export const parseDriveSessionCollection = (
	value: unknown,
): DriveSessionCollection => parse(driveSessionCollectionSchema, value);

export const parseDriveSessionMutation = (value: unknown): DriveSession =>
	parse(driveSessionMutationSchema, value);

export const parseDriveSessionTimezone = (
	value: unknown,
): { timezone: string | null } => parse(driveSessionTimezoneSchema, value);

export const driveSessionGatewayFailure = (
	error: unknown,
): DriveSessionGatewayFailure => {
	if (error instanceof HttpErrorResponse) {
		if (error.status === 0) return { kind: 'unavailable' };
		const apiError = apiErrorSchema.safeParse(error.error);
		return apiError.success
			? {
					kind: 'rejected-response',
					status: error.status,
					message: apiError.data.error,
				}
			: { kind: 'http', status: error.status };
	}
	return error instanceof InvalidDriveSessionResponse
		? { kind: 'invalid-response' }
		: { kind: 'unavailable' };
};

@Injectable()
export class DriveSessionGateway {
	private readonly http = inject(HttpClient);
	private readonly carId = signal('');

	readonly collection = httpResource<DriveSessionCollection>(
		() => {
			const carId = this.carId();
			return carId
				? {
						url: `/api/v1/cars/${encodeURIComponent(carId)}/drives`,
						withCredentials: true,
						params: { history: 'true' },
					}
				: undefined;
		},
		{ parse: parseDriveSessionCollection },
	);

	readonly timezone = httpResource<{ timezone: string | null }>(
		() => ({
			url: '/api/v1/preferences/timezone',
			withCredentials: true,
		}),
		{ parse: parseDriveSessionTimezone },
	);

	selectCar(carId: string): void {
		if (this.carId() !== carId) this.carId.set(carId);
	}

	saveDriveSession(command: SaveDriveSessionCommand): Observable<DriveSession> {
		const carUrl = `/api/v1/cars/${encodeURIComponent(command.carId)}/drives`;
		const { durationMinutes, ...requiredCreateFields } = command.draft;
		const createBody =
			durationMinutes === null
				? requiredCreateFields
				: { ...requiredCreateFields, durationMinutes };
		const request = command.sessionId
			? this.http.patch<unknown>(
					`${carUrl}/${encodeURIComponent(command.sessionId)}`,
					command.draft,
					{ withCredentials: true },
				)
			: this.http.post<unknown>(carUrl, createBody, {
					withCredentials: true,
				});
		return request.pipe(
			map(parseDriveSessionMutation),
			catchError((error: unknown) =>
				throwError(() => driveSessionGatewayFailure(error)),
			),
		);
	}

	archiveDriveSession(
		command: ArchiveDriveSessionCommand,
	): Observable<DriveSession> {
		return this.http
			.delete<unknown>(
				`/api/v1/cars/${encodeURIComponent(command.carId)}/drives/${encodeURIComponent(command.sessionId)}`,
				{ withCredentials: true },
			)
			.pipe(
				map(parseDriveSessionMutation),
				catchError((error: unknown) =>
					throwError(() => driveSessionGatewayFailure(error)),
				),
			);
	}

	collectionFailure(): DriveSessionGatewayFailure | null {
		const error = this.collection.error();
		return error ? driveSessionGatewayFailure(error) : null;
	}

	refresh(): void {
		this.collection.reload();
	}
}
