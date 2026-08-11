import {
	HttpClient,
	HttpErrorResponse,
	httpResource,
} from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { catchError, map, type Observable, throwError } from 'rxjs';
import {
	type GarageCar,
	type GarageCarInput,
	type GarageCollection,
	type GarageGatewayFailure,
	garageCarCollectionResponseSchema,
	garageCarMutationSchema,
} from './garage.models';

class InvalidGarageResponse extends Error {}

export const parseGarageCollection = (value: unknown): GarageCollection => {
	const parsed = garageCarCollectionResponseSchema.safeParse(value);
	if (!parsed.success) throw new InvalidGarageResponse();
	return parsed.data ?? { cars: [] };
};

export const parseGarageMutation = (value: unknown): GarageCar => {
	const parsed = garageCarMutationSchema.safeParse(value);
	if (!parsed.success) throw new InvalidGarageResponse();
	return parsed.data.car;
};

export const garageGatewayFailure = (error: unknown): GarageGatewayFailure => {
	if (error instanceof HttpErrorResponse)
		return error.status === 0 || error.status >= 500
			? { kind: 'unavailable' }
			: { kind: 'http', status: error.status };
	return error instanceof InvalidGarageResponse
		? { kind: 'invalid-response' }
		: { kind: 'unavailable' };
};

@Injectable()
export class GarageGateway {
	private readonly http = inject(HttpClient);
	private readonly showArchived = signal(false);

	readonly collection = httpResource<GarageCollection>(
		() => ({
			url: '/api/v1/cars',
			withCredentials: true,
			params: this.showArchived() ? { archived: 'all' } : undefined,
		}),
		{ parse: parseGarageCollection },
	);

	setShowArchived(showArchived: boolean): void {
		this.showArchived.set(showArchived);
	}

	createCar(input: GarageCarInput): Observable<GarageCar> {
		return this.http
			.post<unknown>('/api/v1/cars', input, { withCredentials: true })
			.pipe(
				map(parseGarageMutation),
				catchError((error: unknown) =>
					throwError(() => garageGatewayFailure(error)),
				),
			);
	}

	collectionFailure(): GarageGatewayFailure | null {
		const error = this.collection.error();
		return error ? garageGatewayFailure(error) : null;
	}

	collectionUnavailable(): boolean {
		return this.collectionFailure()?.kind === 'unavailable';
	}

	refresh(): void {
		this.collection.reload();
	}
}
