import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { catchError, map, throwError, type Observable } from 'rxjs';
import { z } from 'zod';

const signOutResponseSchema = z.object({ success: z.literal(true) });

export type SignOutResponse = z.infer<typeof signOutResponseSchema>;

export type SignOutGatewayFailure =
	| { kind: 'http'; status: number }
	| { kind: 'unavailable' }
	| { kind: 'invalid-response' };

class InvalidSignOutResponse extends Error {}

export const parseSignOutResponse = (value: unknown): SignOutResponse => {
	const parsed = signOutResponseSchema.safeParse(value);
	if (!parsed.success) throw new InvalidSignOutResponse();
	return parsed.data;
};

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
				map(parseSignOutResponse),
				catchError((error: unknown) =>
					throwError(() => signOutGatewayFailure(error)),
				),
			);
	}
}
