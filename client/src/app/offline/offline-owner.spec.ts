import { describe, expect, it } from 'vitest';
import { offlineOwnerFromSession } from './offline-owner';

describe('offlineOwnerFromSession', () => {
	const now = new Date('2026-08-11T12:00:00.000Z');

	it('uses the stable User id and server session expiry', () => {
		expect(
			offlineOwnerFromSession(
				{
					session: { expiresAt: '2026-08-12T12:00:00.000Z' },
					user: { id: 'user-1', email: 'Racer@Example.Test' },
				},
				now,
			),
		).toEqual({
			key: 'user-1',
			email: 'Racer@Example.Test',
			offlineUntil: '2026-08-12T12:00:00.000Z',
		});
	});

	it('falls back to normalized email only when the session is still valid', () => {
		expect(
			offlineOwnerFromSession(
				{
					session: { expiresAt: '2026-08-12T12:00:00.000Z' },
					user: { email: ' Racer@Example.Test ' },
				},
				now,
			),
		).toMatchObject({
			key: 'racer@example.test',
			email: 'Racer@Example.Test',
		});

		for (const response of [
			null,
			{},
			{ session: {}, user: { email: 'racer@example.test' } },
			{
				session: { expiresAt: 'not-a-date' },
				user: { email: 'racer@example.test' },
			},
			{
				session: { expiresAt: '2026-08-11T11:59:59.000Z' },
				user: { email: 'racer@example.test' },
			},
			{
				session: { expiresAt: '2026-08-12T12:00:00.000Z' },
				user: { email: '   ' },
			},
		])
			expect(offlineOwnerFromSession(response, now)).toBeNull();
	});
});
