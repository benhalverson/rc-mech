export type CarReadFailure = {
	message: string;
	retryable: boolean;
};

export const carReadFailure = (
	error: unknown,
	fallback: string,
): CarReadFailure | null => {
	if (!error) return null;
	const status =
		typeof error === 'object' && error !== null && 'status' in error
			? error.status
			: undefined;
	return status === 401
		? {
				message: 'Your garage session has expired. Sign in again to continue.',
				retryable: false,
			}
		: { message: fallback, retryable: true };
};
