import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { catchError, map, type Observable, of, throwError } from 'rxjs';
import * as z from 'zod/mini';
import { type CarPhoto, carPhotoMutationSchema } from '../car.models';
import { parsePhotoCollection } from './car-photo-gateway';
import type { PhotoCapture, PhotoCaptureOutcome } from './photo-sync.models';

export const photoSyncFailure = (
	error: unknown,
): Readonly<{ kind: 'unavailable' | 'invalid-response' }> => ({
	kind:
		error instanceof HttpErrorResponse &&
		(error.status === 0 || error.status >= 500)
			? 'unavailable'
			: 'invalid-response',
});
@Service()
export class PhotoSyncGateway {
	private readonly http = inject(HttpClient);
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
	original(photoId: string): Observable<Blob> {
		return this.http
			.get(`/api/v1/photos/${encodeURIComponent(photoId)}`, {
				withCredentials: true,
				responseType: 'blob',
				headers: { 'ngsw-bypass': 'true' },
			})
			.pipe(
				catchError((error: unknown) =>
					throwError(() => photoSyncFailure(error)),
				),
			);
	}
}
