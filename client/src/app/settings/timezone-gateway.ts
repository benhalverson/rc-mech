import {
	HttpClient,
	HttpErrorResponse,
	httpResource,
} from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { catchError, map, type Observable, throwError } from 'rxjs';
import { minLength, nullable, object, optional, string, trim } from 'zod/mini';
import type { TimezonePreference } from './settings.models';
import type { SaveTimezoneCommand } from './timezone-store';

const timezoneResponseSchema = object({
	timezone: optional(nullable(string())),
});
const apiErrorSchema = object({
	error: string().check(trim(), minLength(1)),
});

export type TimezoneGatewayFailure =
	| { kind: 'http'; status: number; message: string }
	| { kind: 'rejected-response'; message: string }
	| { kind: 'unavailable'; message: string }
	| { kind: 'invalid-response'; message: string };

const failureMessage = 'The timezone setting could not be loaded.';

export const parseTimezonePreference = (value: unknown): TimezonePreference => {
	const parsed = timezoneResponseSchema.safeParse(value);
	if (!parsed.success) throw new Error('The timezone response was invalid.');
	return { timezone: parsed.data.timezone ?? null };
};

export const timezoneGatewayFailure = (
	error: unknown,
): TimezoneGatewayFailure => {
	if (error instanceof HttpErrorResponse) {
		if (error.status === 0)
			return { kind: 'unavailable', message: failureMessage };
		const parsedApiError = apiErrorSchema.safeParse(error.error);
		if (parsedApiError.success)
			return {
				kind: 'rejected-response',
				message: parsedApiError.data.error,
			};
		return {
			kind: 'http',
			status: error.status,
			message: failureMessage,
		};
	}
	if (error instanceof Error && error.message.includes('response was invalid'))
		return {
			kind: 'invalid-response',
			message: 'The timezone response was invalid.',
		};
	return { kind: 'rejected-response', message: failureMessage };
};

@Injectable()
export class TimezoneGateway {
	private readonly http = inject(HttpClient);
	readonly preference = httpResource<TimezonePreference>(
		() => ({
			url: '/api/v1/preferences/timezone',
			withCredentials: true,
		}),
		{ parse: parseTimezonePreference },
	);

	saveTimezone(command: SaveTimezoneCommand): Observable<TimezonePreference> {
		return this.http
			.patch<unknown>('/api/v1/preferences/timezone', command, {
				withCredentials: true,
			})
			.pipe(
				map(parseTimezonePreference),
				catchError((error: unknown) =>
					throwError(() => timezoneGatewayFailure(error)),
				),
			);
	}

	refresh(): void {
		this.preference.reload();
	}
}
