import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import {
	catchError,
	from,
	map,
	switchMap,
	throwError,
	type Observable,
} from 'rxjs';
import {
	InvalidSignOutResponse,
	type SignOutGatewayFailure,
	type SignOutResponse,
} from './sign-out-contract';

export const signOutGatewayFailure = (
	error: unknown,
): SignOutGatewayFailure => {
	if (error instanceof HttpErrorResponse)
		return error.status === 0
			? { kind: 'unavailable' }
			: { kind: 'http', status: error.status };
	if (error instanceof InvalidSignOutResponse)
		return { kind: 'invalid-response' };
	return { kind: 'unavailable' };
};

@Service()
export class SignOutGateway {
	private readonly http = inject(HttpClient);

	signOut(): Observable<SignOutResponse> {
		return this.http
			.post<unknown>('/api/auth/sign-out', {}, { withCredentials: true })
			.pipe(
				switchMap((response) =>
					from(import('./sign-out-response')).pipe(
						map(({ parseSignOutResponse }) => parseSignOutResponse(response)),
					),
				),
				catchError((error: unknown) =>
					throwError(() => signOutGatewayFailure(error)),
				),
			);
	}
}
