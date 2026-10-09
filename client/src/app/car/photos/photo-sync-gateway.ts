import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { catchError, map, type Observable, of, throwError } from 'rxjs';
import * as z from 'zod/mini';
import {
	type CarPhoto,
	carPhotoMutationSchema,
	carPhotoSchema,
} from '../car.models';
import { parsePhotoCollection, photoGatewayFailure } from './car-photo-gateway';
import type {
	PhotoCapture,
	PhotoCaptureOutcome,
	PhotoChangeOperation,
	PhotoChangeOutcome,
} from './photo-sync.models';

export const photoSyncFailure = (
	error: unknown,
): Readonly<{ kind: 'unavailable' | 'invalid-response' }> => ({
	kind:
		error instanceof HttpErrorResponse &&
		(error.status === 0 || error.status >= 500)
			? 'unavailable'
			: 'invalid-response',
});
/**
 * HTTP boundary used by PhotoWorkspaceStore to replay durable captures/edits and load
 * owner photo metadata, and by PhotoMediaAccess to fetch original bytes. Validates
 * acknowledgements against the submitted identities; queue ordering, persistence,
 * and retry decisions remain in the workspace store and storage capability.
 */
@Service()
export class PhotoSyncGateway {
	private readonly http = inject(HttpClient);
	change(operation: PhotoChangeOperation): Observable<PhotoChangeOutcome> {
		const body = new FormData();
		body.set('command', JSON.stringify(operation.command));
		if (operation.blob && operation.command.replacement)
			body.set('file', operation.blob, operation.command.replacement.fileName);
		const rejected = z.object({
			operationId: z.literal(operation.operationId),
			outcome: z.union([z.literal('rejected'), z.literal('conflict')]),
			error: z.object({ code: z.string(), message: z.string() }),
			remote: z.optional(z.array(carPhotoSchema)),
		});
		return this.http
			.put<unknown>(
				`/api/v1/cars/${encodeURIComponent(operation.carId)}/photos/operations/${encodeURIComponent(operation.operationId)}`,
				body,
				{ withCredentials: true, headers: { 'ngsw-bypass': 'true' } },
			)
			.pipe(
				map((value) => {
					const result = z
						.object({
							operationId: z.literal(operation.operationId),
							outcome: z.literal('applied'),
							photos: z.array(carPhotoSchema),
						})
						.parse(value);
					if (result.photos.some((photo) => photo.carId !== operation.carId))
						throw new Error('Invalid gallery acknowledgement.');
					return result;
				}),
				catchError((error: unknown) => {
					if (
						error instanceof HttpErrorResponse &&
						error.status >= 400 &&
						error.status < 500
					) {
						const result = rejected.safeParse(error.error);
						if (
							result.success &&
							!result.data.remote?.some(
								(photo) => photo.carId !== operation.carId,
							)
						)
							return of(result.data);
					}
					return throwError(() => photoSyncFailure(error));
				}),
			);
	}

	apply(capture: PhotoCapture): Observable<PhotoCaptureOutcome> {
		const body = new FormData();
		body.append('file', capture.blob, capture.fileName);
		return this.http
			.put<unknown>(
				`/api/v1/cars/${encodeURIComponent(capture.carId)}/photos/captures/${encodeURIComponent(capture.operationId)}`,
				body,
				{ withCredentials: true, headers: { 'ngsw-bypass': 'true' } },
			)
			.pipe(
				map((value) => {
					const parsed = z
						.extend(carPhotoMutationSchema, {
							operationId: z.literal(capture.operationId),
							outcome: z.literal('applied'),
						})
						.parse(value);
					if (
						parsed.photo.id !== capture.operationId ||
						parsed.photo.carId !== capture.carId
					)
						throw new Error('Invalid capture acknowledgement.');
					return parsed;
				}),
				catchError((error: unknown) => {
					if (
						error instanceof HttpErrorResponse &&
						error.status >= 400 &&
						error.status < 500
					) {
						const parsed = z
							.object({ error: z.string().check(z.minLength(1)) })
							.safeParse(error.error);
						if (parsed.success)
							return of({
								operationId: capture.operationId,
								outcome: 'rejected' as const,
								error: parsed.data.error,
							});
					}
					return throwError(() => photoSyncFailure(error));
				}),
			);
	}
	metadata(): Observable<readonly CarPhoto[]> {
		return this.http
			.get<unknown>('/api/v1/photos', { withCredentials: true })
			.pipe(
				map((value) => parsePhotoCollection(value).photos),
				catchError((error: unknown) =>
					throwError(() => photoSyncFailure(error)),
				),
			);
	}
	/** Preserves HTTP status and unexpected read errors for per-photo recovery. */
	original(
		photoId: string,
	): Observable<Readonly<{ blob: Blob; revision: number }>> {
		return this.http
			.get(`/api/v1/photos/${encodeURIComponent(photoId)}`, {
				withCredentials: true,
				responseType: 'blob',
				observe: 'response',
				headers: { 'ngsw-bypass': 'true', 'Cache-Control': 'no-cache' },
			})
			.pipe(
				map((response) => {
					const revision = Number(
						response.headers.get('X-Photo-Revision') ?? '1',
					);
					if (!response.body || !Number.isSafeInteger(revision) || revision < 1)
						throw new Error('Invalid photo revision.');
					return { blob: response.body, revision };
				}),
				catchError((error: unknown) =>
					throwError(() =>
						error instanceof HttpErrorResponse
							? photoGatewayFailure(error)
							: error,
					),
				),
			);
	}
}
