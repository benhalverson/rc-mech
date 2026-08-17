import {
	HttpClient,
	HttpErrorResponse,
	httpResource,
} from '@angular/common/http';
import { computed, inject, Service, signal } from '@angular/core';
import { catchError, map, type Observable, throwError } from 'rxjs';
import type * as z from 'zod/mini';
import { minLength, safeParse, strictObject, string, trim } from 'zod/mini';
import {
	type CreateDrivingAnalysisCommand,
	type DrivingAnalysis,
	type DrivingAnalysisGatewayFailure,
	drivingAnalysisResponseSchema,
} from './driving-analysis.models';

const apiErrorSchema = strictObject({
	error: string().check(trim(), minLength(1)),
});

class InvalidDrivingAnalysisResponse extends Error {}

const parse = <T>(schema: z.core.$ZodType<T>, value: unknown): T => {
	const result = safeParse(schema, value);
	if (!result.success)
		throw new InvalidDrivingAnalysisResponse(
			'The Driving-analysis response was invalid.',
		);
	return result.data;
};

export const parseDrivingAnalysis = (value: unknown): DrivingAnalysis =>
	parse(drivingAnalysisResponseSchema, value);

export const drivingAnalysisGatewayFailure = (
	error: unknown,
): DrivingAnalysisGatewayFailure => {
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
	return error instanceof InvalidDrivingAnalysisResponse
		? { kind: 'invalid-response' }
		: { kind: 'unavailable' };
};

const createUrl = (carId: string, driveSessionId: string): string =>
	`/api/v1/cars/${encodeURIComponent(carId)}/drives/${encodeURIComponent(driveSessionId)}/driving-analyses`;

@Service()
export class DrivingAnalysisGateway {
	private readonly http = inject(HttpClient);
	private readonly analysisId = signal('');
	readonly analysis = httpResource<DrivingAnalysis>(
		() => {
			const analysisId = this.analysisId();
			return analysisId
				? {
						url: `/api/v1/driving-analyses/${encodeURIComponent(analysisId)}`,
						withCredentials: true,
					}
				: undefined;
		},
		{ parse: parseDrivingAnalysis },
	);
	readonly analysisFailure = computed(() => {
		const error = this.analysis.error();
		return error ? drivingAnalysisGatewayFailure(error) : null;
	});

	create(command: CreateDrivingAnalysisCommand): Observable<DrivingAnalysis> {
		return this.parseRequest(
			this.http.post<unknown>(
				createUrl(command.carId, command.driveSessionId),
				{
					requestId: command.requestId,
					raceVideoId: command.raceVideoId,
					approvedTrackMapVersionId: command.approvedTrackMapVersionId,
					raceWindow: command.raceWindow,
					subjectSeed: command.subjectSeed,
				},
				{ withCredentials: true },
			),
		);
	}

	selectAnalysis(analysisId: string | null): void {
		this.analysisId.set(analysisId ?? '');
	}

	refresh(): void {
		this.analysis.reload();
	}

	private parseRequest(
		request: Observable<unknown>,
	): Observable<DrivingAnalysis> {
		return request.pipe(
			map(parseDrivingAnalysis),
			catchError((error: unknown) =>
				throwError(() => drivingAnalysisGatewayFailure(error)),
			),
		);
	}
}
