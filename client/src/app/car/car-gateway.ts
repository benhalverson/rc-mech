import {
	HttpClient,
	HttpErrorResponse,
	httpResource,
} from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { catchError, map, throwError, type Observable } from 'rxjs';
import {
	garageCarMutationSchema,
	type GarageCar,
} from '../garage/garage.models';
import type {
	CarGatewayFailure,
	ChangeCarLifecycleCommand,
	UpdateCarCommand,
} from './car.models';

class InvalidCarResponse extends Error {}

export const parseCarResponse = (value: unknown): GarageCar => {
	const parsed = garageCarMutationSchema.safeParse(value);
	if (!parsed.success) throw new InvalidCarResponse();
	return parsed.data.car;
};

export const carGatewayFailure = (error: unknown): CarGatewayFailure => {
	if (error instanceof HttpErrorResponse)
		return error.status === 0
			? { kind: 'unavailable' }
			: { kind: 'http', status: error.status };
	return error instanceof InvalidCarResponse
		? { kind: 'invalid-response' }
		: { kind: 'unavailable' };
};

@Injectable()
export class CarGateway {
	private readonly http = inject(HttpClient);
	private readonly carId = signal('');

	readonly car = httpResource<GarageCar>(
		() => {
			const carId = this.carId();
			return carId
				? {
						url: `/api/v1/cars/${encodeURIComponent(carId)}`,
						withCredentials: true,
					}
				: undefined;
		},
		{ parse: parseCarResponse },
	);

	selectCar(carId: string): void {
		if (this.carId() !== carId) this.carId.set(carId);
	}

	updateCar(command: UpdateCarCommand): Observable<GarageCar> {
		return this.http
			.patch<unknown>(
				`/api/v1/cars/${encodeURIComponent(command.carId)}`,
				command.input,
				{ withCredentials: true },
			)
			.pipe(
				map(parseCarResponse),
				catchError((error: unknown) =>
					throwError(() => carGatewayFailure(error)),
				),
			);
	}

	changeLifecycle(command: ChangeCarLifecycleCommand): Observable<GarageCar> {
		return this.http
			.post<unknown>(
				`/api/v1/cars/${encodeURIComponent(command.carId)}/${command.action}`,
				{},
				{ withCredentials: true },
			)
			.pipe(
				map(parseCarResponse),
				catchError((error: unknown) =>
					throwError(() => carGatewayFailure(error)),
				),
			);
	}

	failure(): CarGatewayFailure | null {
		const error = this.car.error();
		return error ? carGatewayFailure(error) : null;
	}

	refresh(): void {
		this.car.reload();
	}
}
