import {
	HttpClient,
	HttpErrorResponse,
	httpResource,
} from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { catchError, map, type Observable, throwError } from 'rxjs';
import {
	type BuildGatewayFailure,
	type InstalledComponent,
	installedComponentCollectionSchema,
	installedComponentMutationSchema,
	type SaveBuildCommand,
} from './car.models';

class InvalidBuildResponse extends Error {}

export const parseBuildCollection = (
	value: unknown,
): { components: InstalledComponent[] } => {
	const parsed = installedComponentCollectionSchema.safeParse(value);
	if (!parsed.success) throw new InvalidBuildResponse();
	return parsed.data;
};

export const parseBuildMutation = (value: unknown): InstalledComponent => {
	const parsed = installedComponentMutationSchema.safeParse(value);
	if (!parsed.success) throw new InvalidBuildResponse();
	return parsed.data.component;
};

export const buildGatewayFailure = (error: unknown): BuildGatewayFailure => {
	if (error instanceof HttpErrorResponse)
		return error.status === 0
			? { kind: 'unavailable' }
			: { kind: 'http', status: error.status };
	return error instanceof InvalidBuildResponse
		? { kind: 'invalid-response' }
		: { kind: 'unavailable' };
};

@Injectable()
export class CarBuildGateway {
	private readonly http = inject(HttpClient);
	private readonly carId = signal('');

	readonly collection = httpResource<{ components: InstalledComponent[] }>(
		() => {
			const carId = this.carId();
			return carId
				? {
						url: `/api/v1/cars/${encodeURIComponent(carId)}/components`,
						withCredentials: true,
						params: { history: 'true' },
					}
				: undefined;
		},
		{ parse: parseBuildCollection },
	);

	selectCar(carId: string): void {
		if (this.carId() !== carId) this.carId.set(carId);
	}

	save(command: SaveBuildCommand): Observable<InstalledComponent> {
		const collectionUrl = `/api/v1/cars/${encodeURIComponent(command.carId)}/components`;
		const componentUrl = command.componentId
			? `${collectionUrl}/${encodeURIComponent(command.componentId)}`
			: collectionUrl;
		const request =
			command.mode === 'edit'
				? this.http.patch<unknown>(componentUrl, command.input, {
						withCredentials: true,
					})
				: this.http.post<unknown>(
						command.mode === 'replace'
							? `${componentUrl}/replace`
							: collectionUrl,
						command.input,
						{ withCredentials: true },
					);
		return request.pipe(
			map(parseBuildMutation),
			catchError((error: unknown) =>
				throwError(() => buildGatewayFailure(error)),
			),
		);
	}

	failure(): BuildGatewayFailure | null {
		const error = this.collection.error();
		return error ? buildGatewayFailure(error) : null;
	}

	refresh(): void {
		this.collection.reload();
	}
}
