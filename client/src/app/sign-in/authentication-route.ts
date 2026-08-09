type AuthenticationQuery = {
	get(name: string): string | null;
	has(name: string): boolean;
};

export type AuthenticationRouteContext = Readonly<{
	returnTo: string;
	message: string;
}>;

const callbackErrorParameters = [
	'error',
	'error_description',
	'error_code',
	'errorCode',
] as const;

export const authenticationRouteContext = (
	query: AuthenticationQuery,
): AuthenticationRouteContext => {
	const requestedReturn = query.get('returnTo');
	const returnTo =
		requestedReturn?.startsWith('/') && !requestedReturn.startsWith('//')
			? requestedReturn
			: '/garage';
	const message =
		query.get('reason') === 'session-expired'
			? 'Your garage session has expired. Sign in again to continue.'
			: callbackErrorParameters.some((parameter) => query.has(parameter))
				? 'That recovery link could not be used. Request a new magic link and try again.'
				: '';
	return { returnTo, message };
};
