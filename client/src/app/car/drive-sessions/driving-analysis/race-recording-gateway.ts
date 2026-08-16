import {
	HttpClient,
	HttpErrorResponse,
	HttpEventType,
	httpResource,
} from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { catchError, filter, map, type Observable, throwError } from 'rxjs';
import type * as z from 'zod/mini';
import { minLength, object, safeParse, string, trim } from 'zod/mini';
import {
	type RaceRecording,
	type RaceRecordingCollection,
	type RaceRecordingGatewayFailure,
	type RaceRecordingIdentity,
	type RaceRecordingTransferEvent,
	raceRecordingCollectionSchema,
	raceRecordingMutationSchema,
} from './race-recording.models';

const apiErrorSchema = object({
	error: string().check(trim(), minLength(1)),
});

class InvalidRaceRecordingResponse extends Error {}

const parse = <T>(schema: z.core.$ZodType<T>, value: unknown): T => {
	const result = safeParse(schema, value);
	if (!result.success)
		throw new InvalidRaceRecordingResponse(
			'The Race-recording response was invalid.',
		);
	return result.data;
};

export const parseRaceRecordingCollection = (
	value: unknown,
): RaceRecordingCollection => parse(raceRecordingCollectionSchema, value);

export const parseRaceRecordingMutation = (value: unknown): RaceRecording =>
	parse(raceRecordingMutationSchema, value);

export const raceRecordingGatewayFailure = (
	error: unknown,
): RaceRecordingGatewayFailure => {
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
	return error instanceof InvalidRaceRecordingResponse
		? { kind: 'invalid-response' }
		: { kind: 'unavailable' };
};

const recordingUrl = (recordingId: string): string =>
	`/api/v1/race-videos/${encodeURIComponent(recordingId)}`;

const createRecordingUrl = (carId: string, driveSessionId: string): string =>
	`/api/v1/cars/${encodeURIComponent(carId)}/drives/${encodeURIComponent(driveSessionId)}/race-videos`;

@Injectable()
export class RaceRecordingGateway {
	private readonly http = inject(HttpClient);
	private readonly carId = signal('');

	readonly collection = httpResource<RaceRecordingCollection>(
		() => {
			const carId = this.carId();
			return carId
				? {
						url: `/api/v1/cars/${encodeURIComponent(carId)}/race-videos`,
						withCredentials: true,
					}
				: undefined;
		},
		{ parse: parseRaceRecordingCollection },
	);

	selectCar(carId: string): void {
		if (this.carId() !== carId) this.carId.set(carId);
	}

	createUpload(command: {
		carId: string;
		driveSessionId: string;
		fileName: string;
		contentType: string;
		sizeBytes: number;
		requestId: string;
	}): Observable<RaceRecording> {
		return this.http
			.post<unknown>(
				createRecordingUrl(command.carId, command.driveSessionId),
				{
					fileName: command.fileName,
					contentType: command.contentType,
					sizeBytes: command.sizeBytes,
					requestId: command.requestId,
				},
				{ withCredentials: true },
			)
			.pipe(
				map(parseRaceRecordingMutation),
				catchError((error: unknown) =>
					throwError(() => raceRecordingGatewayFailure(error)),
				),
			);
	}

	uploadPart(
		command: RaceRecordingIdentity & {
			partNumber: number;
			transferRequestId: string;
			bytes: Blob;
		},
	): Observable<RaceRecordingTransferEvent> {
		return this.http
			.put<unknown>(
				`${recordingUrl(command.recordingId)}/upload-parts/${command.partNumber}`,
				command.bytes,
				{
					headers: { 'x-transfer-request-id': command.transferRequestId },
					observe: 'events',
					reportProgress: true,
					withCredentials: true,
				},
			)
			.pipe(
				map((event): RaceRecordingTransferEvent | null => {
					if (event.type === HttpEventType.UploadProgress)
						return {
							kind: 'progress',
							loaded: event.loaded,
							total: event.total ?? command.bytes.size,
						};
					if (event.type === HttpEventType.Response)
						return {
							kind: 'completed',
							recording: parseRaceRecordingMutation(event.body),
						};
					return null;
				}),
				filter((event): event is RaceRecordingTransferEvent => event !== null),
				catchError((error: unknown) =>
					throwError(() => raceRecordingGatewayFailure(error)),
				),
			);
	}

	completeUpload(command: RaceRecordingIdentity): Observable<RaceRecording> {
		return this.http
			.post<unknown>(`${recordingUrl(command.recordingId)}/complete`, null, {
				withCredentials: true,
			})
			.pipe(
				map(parseRaceRecordingMutation),
				catchError((error: unknown) =>
					throwError(() => raceRecordingGatewayFailure(error)),
				),
			);
	}

	deleteRecording(command: RaceRecordingIdentity): Observable<void> {
		return this.http
			.delete<void>(recordingUrl(command.recordingId), {
				withCredentials: true,
			})
			.pipe(
				catchError((error: unknown) =>
					throwError(() => raceRecordingGatewayFailure(error)),
				),
			);
	}

	collectionFailure(): RaceRecordingGatewayFailure | null {
		const error = this.collection.error();
		return error ? raceRecordingGatewayFailure(error) : null;
	}

	refresh(): void {
		this.collection.reload();
	}
}
