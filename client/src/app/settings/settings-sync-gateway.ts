import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { catchError, map, type Observable, of, throwError } from 'rxjs';
import {
	type SettingsOperation,
	type SettingsRemoteOutcome,
	settingsOutcomeSchema,
} from './settings-sync.models';

export type SettingsSyncFailure =
	| Readonly<{ kind: 'unavailable' | 'invalid-response' }>
	| Readonly<{ kind: 'http'; status: number }>;
export const settingsSyncFailure = (error: unknown): SettingsSyncFailure =>
	error instanceof HttpErrorResponse
		? error.status === 0 || error.status >= 500
			? { kind: 'unavailable' }
			: { kind: 'http', status: error.status }
		: { kind: 'invalid-response' };

@Service()
export class SettingsSyncGateway {
	private readonly http = inject(HttpClient);
	apply(operation: SettingsOperation): Observable<SettingsRemoteOutcome> {
		return this.http
			.put<unknown>(
				`/api/v1/settings/sync/operations/${encodeURIComponent(operation.operationId)}`,
				{ contractVersion: 1, command: operation.command },
				{ withCredentials: true },
			)
			.pipe(
				catchError((error: unknown) =>
					error instanceof HttpErrorResponse && error.status === 409
						? of(error.error as unknown)
						: throwError(() => error),
				),
				map((value) => {
					const parsed = settingsOutcomeSchema.safeParse(value);
					if (
						!parsed.success ||
						parsed.data.operationId !== operation.operationId
					)
						throw new Error('Invalid Settings sync response.');
					const outcome = parsed.data;
					if (outcome.outcome === 'applied') {
						const command = operation.command;
						const valid =
							command.type === 'timezone'
								? outcome.timezone === command.timezone
								: command.type === 'invite-create'
									? outcome.invite?.id === operation.operationId
									: outcome.revokedInviteId === command.inviteId;
						if (!valid) throw new Error('Invalid Settings sync response.');
					}
					return outcome;
				}),
				catchError((error: unknown) =>
					throwError(() => settingsSyncFailure(error)),
				),
			);
	}
}
