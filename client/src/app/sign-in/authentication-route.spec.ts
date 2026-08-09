import { describe, expect, it } from 'vitest';
import { authenticationRouteContext } from './authentication-route';

const query = (values: Record<string, string>) => ({
	get: (name: string) => values[name] ?? null,
	has: (name: string) => name in values,
});

describe('authentication route context', () => {
	it('preserves safe local destinations', () => {
		expect(
			authenticationRouteContext(
				query({ returnTo: '/garage/car-42/photos?mode=grid#latest' }),
			),
		).toEqual({
			returnTo: '/garage/car-42/photos?mode=grid#latest',
			message: '',
		});
	});

	it.each(['//evil.test', '/\\evil.test', 'https://evil.test', 'garage'])(
		'normalizes the unsafe destination %s',
		(returnTo) => {
			expect(authenticationRouteContext(query({ returnTo })).returnTo).toBe(
				'/garage',
			);
		},
	);

	it('prioritizes expired sessions over callback errors', () => {
		expect(
			authenticationRouteContext(
				query({ reason: 'session-expired', error: 'also-present' }),
			).message,
		).toContain('session has expired');
	});

	it.each(['error', 'error_description', 'error_code', 'errorCode'])(
		'describes the callback failure parameter %s',
		(parameter) => {
			expect(
				authenticationRouteContext(query({ [parameter]: 'expired' })).message,
			).toContain('recovery link could not be used');
		},
	);
});
