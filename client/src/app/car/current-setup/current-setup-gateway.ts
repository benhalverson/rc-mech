import {
	HttpClient,
	HttpErrorResponse,
	httpResource,
} from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { catchError, map, type Observable, throwError } from 'rxjs';
import { minLength, object, string, trim } from 'zod/mini';
import { ShellRouteContext } from '../../shell/shell-route-context';
import {
	type CurrentSetupCollection,
	type CurrentSetupGatewayFailure,
	type CurrentSetupSnapshot,
	parseCurrentSetupCollection,
	parseCurrentSetupMutation,
	parseCurrentSetupTimezone,
	type SaveCurrentSetupCommand,
} from './current-setup.models';

export type { CurrentSetupGatewayFailure } from './current-setup.models';

const apiErrorSchema = object({
	error: string().check(trim(), minLength(1)),
});

export const currentSetupGatewayFailure = (
	error: unknown,
): CurrentSetupGatewayFailure => {
	if (error instanceof HttpErrorResponse)
		if (error.status === 0) return { kind: 'unavailable' };
		else {
			const parsed = apiErrorSchema.safeParse(error.error);
			return parsed.success
				? {
						kind: 'rejected-response',
						status: error.status,
						message: parsed.data.error,
					}
				: { kind: 'http', status: error.status };
		}
	return error instanceof Error &&
		error.message.includes('response was invalid')
		? { kind: 'invalid-response' }
		: { kind: 'unavailable' };
};

@Service()
export class CurrentSetupGateway {
	private readonly http = inject(HttpClient);
	private readonly route = inject(ShellRouteContext);
	readonly collection = httpResource<CurrentSetupCollection>(
		() => {
			const carId = this.route.carId();
			return carId
				? {
						url: `/api/v1/cars/${encodeURIComponent(carId)}/setups`,
						withCredentials: true,
					}
				: undefined;
		},
		{ parse: parseCurrentSetupCollection },
	);
	readonly timezone = httpResource<{ readonly timezone: string | null }>(
		() => ({
			url: '/api/v1/preferences/timezone',
			withCredentials: true,
		}),
		{ parse: parseCurrentSetupTimezone },
	);

	saveCurrentSetup(
		command: SaveCurrentSetupCommand,
	): Observable<CurrentSetupSnapshot> {
		const { sections, recordedAt, ...context } = command.draft;
		const notes = sections.notes['setupNotes'];
		return this.http
			.post<unknown>(
				`/api/v1/cars/${encodeURIComponent(command.carId)}/setups/${encodeURIComponent(command.sourceSetupId)}/copy`,
				{
					...context,
					expectedCurrentSetupId: command.sourceSetupId,
					expectedSourceUpdatedAt: command.sourceUpdatedAt,
					setupDate: recordedAt,
					vehicle: sections.vehicle,
					drivetrain: sections.drivetrain,
					electronics: sections.electronics,
					tires: sections.tires,
					shocks: sections.shocks,
					frontSuspension: sections.frontSuspension,
					rearSuspension: sections.rearSuspension,
					notes: typeof notes === 'string' ? notes : null,
					makeCurrent: true,
				},
				{ withCredentials: true },
			)
			.pipe(
				map(parseCurrentSetupMutation),
				catchError((error: unknown) =>
					throwError(() => currentSetupGatewayFailure(error)),
				),
			);
	}

	failure(): CurrentSetupGatewayFailure | null {
		const error = this.collection.error();
		return error ? currentSetupGatewayFailure(error) : null;
	}

	refresh(): void {
		this.collection.reload();
	}
}
