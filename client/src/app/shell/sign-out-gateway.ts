import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { InjectionToken, inject, Service } from '@angular/core';
import {
	catchError,
	defer,
	map,
	type Observable,
	switchMap,
	throwError,
} from 'rxjs';
import {
	InvalidSignOutResponse,
	type SignOutGatewayFailure,
} from './sign-out-contract';
import type { SignOutResponse } from './sign-out-response';

export type SignOutResponseModule = typeof import('./sign-out-response');
export type SignOutResponseLoader = () => Promise<SignOutResponseModule>;

export const SIGN_OUT_RESPONSE_LOADER =
	new InjectionToken<SignOutResponseLoader>('SIGN_OUT_RESPONSE_LOADER', {
		providedIn: 'root',
		factory: () => () => import('./sign-out-response'),
	});

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
	private readonly loadResponseParser = inject(SIGN_OUT_RESPONSE_LOADER);

	signOut(): Observable<SignOutResponse> {
		return defer(this.loadResponseParser).pipe(
			switchMap(({ parseSignOutResponse }) =>
				this.http
					.post<unknown>('/api/auth/sign-out', {}, { withCredentials: true })
					.pipe(map(parseSignOutResponse)),
			),
			catchError((error: unknown) =>
				throwError(() => signOutGatewayFailure(error)),
			),
		);
	}
}
