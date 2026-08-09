import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { DOCUMENT } from '@angular/common';
import { inject, Injectable, InjectionToken } from '@angular/core';
import { catchError, map, throwError, type Observable } from 'rxjs';
import { type z } from 'zod';
import {
	accessResponseSchema,
	type AuthenticationGatewayFailure,
	passkeyRequestOptionsSchema,
	type PasskeyRequestOptions,
	type RegisterCommand,
	type RequestMagicLinkCommand,
	verifiedAuthenticationSchema,
	type VerifyPasskeyCommand,
} from './authentication.models';

class InvalidAuthenticationResponse extends Error {}

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
	const result = schema.safeParse(value);
	if (!result.success)
		throw new InvalidAuthenticationResponse(
			'The authentication response was invalid.',
		);
	return result.data;
};

export const parseAccessResponse = (value: unknown): void => {
	parse(accessResponseSchema, value);
};

export const parsePasskeyRequestOptions = (
	value: unknown,
): PasskeyRequestOptions => parse(passkeyRequestOptionsSchema, value);

export const parseVerifiedAuthentication = (value: unknown): void => {
	parse(verifiedAuthenticationSchema, value);
};

export const authenticationGatewayFailure = (
	error: unknown,
): AuthenticationGatewayFailure => {
	if (error instanceof HttpErrorResponse) {
		if (error.status === 0) return { kind: 'unavailable' };
		return error.status === 429
			? { kind: 'rate-limited', status: 429 }
			: { kind: 'http', status: error.status };
	}
	return error instanceof InvalidAuthenticationResponse
		? { kind: 'invalid-response' }
		: { kind: 'unavailable' };
};

export const AUTHENTICATION_ORIGIN = new InjectionToken<string>(
	'AUTHENTICATION_ORIGIN',
	{
		factory: () => inject(DOCUMENT).location?.origin ?? 'http://localhost',
	},
);

@Injectable()
export class AuthenticationGateway {
	private readonly http = inject(HttpClient);
	private readonly origin = inject(AUTHENTICATION_ORIGIN);

	requestMagicLink(
		command: RequestMagicLinkCommand,
		returnTo: string,
	): Observable<void> {
		return this.http
			.post<unknown>(
				'/api/auth/sign-in/magic-link',
				{
					email: command.email,
					callbackURL: new URL(returnTo, this.origin).toString(),
				},
				{ withCredentials: true },
			)
			.pipe(
				map(parseAccessResponse),
				catchError((error: unknown) =>
					throwError(() => authenticationGatewayFailure(error)),
				),
			);
	}

	register(command: RegisterCommand, returnTo: string): Observable<void> {
		return this.http
			.post<unknown>(
				'/api/auth/register',
				{
					email: command.email,
					inviteCode: command.inviteCode,
					callbackURL: returnTo,
				},
				{ withCredentials: true },
			)
			.pipe(
				map(parseAccessResponse),
				catchError((error: unknown) =>
					throwError(() => authenticationGatewayFailure(error)),
				),
			);
	}

	authenticationOptions(): Observable<PasskeyRequestOptions> {
		return this.http
			.get<unknown>('/api/auth/passkey/generate-authenticate-options', {
				withCredentials: true,
			})
			.pipe(
				map(parsePasskeyRequestOptions),
				catchError((error: unknown) =>
					throwError(() => authenticationGatewayFailure(error)),
				),
			);
	}

	verifyAuthentication(command: VerifyPasskeyCommand): Observable<void> {
		return this.http
			.post<unknown>(
				'/api/auth/passkey/verify-authentication',
				{ response: command.response },
				{ withCredentials: true },
			)
			.pipe(
				map(parseVerifiedAuthentication),
				catchError((error: unknown) =>
					throwError(() => authenticationGatewayFailure(error)),
				),
			);
	}
}
