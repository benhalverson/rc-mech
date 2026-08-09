import {
	HttpClient,
	HttpErrorResponse,
	httpResource,
} from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { catchError, map, type Observable, throwError } from 'rxjs';
import {
	type CarPhoto,
	carPhotoCollectionSchema,
	carPhotoDeletionSchema,
	carPhotoMutationSchema,
	type PhotoGatewayFailure,
} from '../car.models';

class InvalidPhotoResponse extends Error {}

const parse = <T>(
	result: { success: true; data: T } | { success: false },
): T => {
	if (!result.success) throw new InvalidPhotoResponse();
	return result.data;
};

export const parsePhotoCollection = (value: unknown): { photos: CarPhoto[] } =>
	parse(carPhotoCollectionSchema.safeParse(value));

export const parsePhotoMutation = (value: unknown): CarPhoto =>
	parse(carPhotoMutationSchema.safeParse(value)).photo;

export const parsePhotoDeletion = (
	value: unknown,
): { deleted: boolean; primaryPhotoId?: string | null } =>
	parse(carPhotoDeletionSchema.safeParse(value));

export const photoGatewayFailure = (error: unknown): PhotoGatewayFailure => {
	if (error instanceof HttpErrorResponse)
		return error.status === 0
			? { kind: 'unavailable' }
			: { kind: 'http', status: error.status };
	return error instanceof InvalidPhotoResponse
		? { kind: 'invalid-response' }
		: { kind: 'unavailable' };
};

@Injectable()
export class CarPhotoGateway {
	private readonly http = inject(HttpClient);
	private readonly carId = signal('');

	readonly collection = httpResource<{ photos: CarPhoto[] }>(
		() => {
			const carId = this.carId();
			return carId
				? {
						url: `/api/v1/cars/${encodeURIComponent(carId)}/photos`,
						withCredentials: true,
					}
				: undefined;
		},
		{ parse: parsePhotoCollection },
	);

	selectCar(carId: string): void {
		if (this.carId() !== carId) this.carId.set(carId);
	}

	upload(carId: string, file: File): Observable<CarPhoto> {
		return this.sendFile(
			`/api/v1/cars/${encodeURIComponent(carId)}/photos`,
			file,
		);
	}

	replace(photo: CarPhoto, file: File): Observable<CarPhoto> {
		return this.sendFile(`${this.endpoint(photo)}/replace`, file);
	}

	setPrimary(photo: CarPhoto): Observable<CarPhoto> {
		return this.http
			.patch<unknown>(
				this.endpoint(photo),
				{ isPrimary: true },
				{ withCredentials: true },
			)
			.pipe(
				map(parsePhotoMutation),
				catchError((error: unknown) =>
					throwError(() => photoGatewayFailure(error)),
				),
			);
	}

	delete(photo: CarPhoto): Observable<{
		deleted: boolean;
		primaryPhotoId?: string | null;
	}> {
		return this.http
			.delete<unknown>(this.endpoint(photo), { withCredentials: true })
			.pipe(
				map(parsePhotoDeletion),
				catchError((error: unknown) =>
					throwError(() => photoGatewayFailure(error)),
				),
			);
	}

	reorder(carId: string, photos: readonly CarPhoto[]): Observable<CarPhoto[]> {
		return this.http
			.patch<unknown>(
				`/api/v1/cars/${encodeURIComponent(carId)}/photos/reorder`,
				{ photoIds: photos.map((photo) => photo.id) },
				{ withCredentials: true },
			)
			.pipe(
				map((value) => parsePhotoCollection(value).photos),
				catchError((error: unknown) =>
					throwError(() => photoGatewayFailure(error)),
				),
			);
	}

	failure(): PhotoGatewayFailure | null {
		const error = this.collection.error();
		return error ? photoGatewayFailure(error) : null;
	}

	refresh(): void {
		this.collection.reload();
	}

	private sendFile(url: string, file: File): Observable<CarPhoto> {
		const body = new FormData();
		body.append('file', file, file.name);
		return this.http.post<unknown>(url, body, { withCredentials: true }).pipe(
			map(parsePhotoMutation),
			catchError((error: unknown) =>
				throwError(() => photoGatewayFailure(error)),
			),
		);
	}

	private endpoint(photo: CarPhoto): string {
		return `/api/v1/cars/${encodeURIComponent(photo.carId)}/photos/${encodeURIComponent(photo.id)}`;
	}
}
