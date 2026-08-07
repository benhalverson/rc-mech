import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
	inviteReservationExpiry,
	isExpiredReservation,
	normalizeInviteCode,
	validateInviteCode,
} from './invite-policy.ts';

test('invite codes normalize and enforce the shareable policy', () => {
	assert.equal(normalizeInviteCode(' pit-42x '), 'PIT-42X');
	assert.deepEqual(validateInviteCode('pit-42x'), {
		ok: true,
		code: 'PIT-42X',
	});
	assert.equal(validateInviteCode('bad_code').ok, false);
	assert.equal(validateInviteCode('settings').ok, false);
});
test('invite reservations expire after fifteen minutes', () => {
	const now = Date.parse('2026-08-06T12:00:00.000Z');
	assert.equal(inviteReservationExpiry(now), '2026-08-06T12:15:00.000Z');
	assert.equal(
		isExpiredReservation(inviteReservationExpiry(now), now + 1),
		false,
	);
	assert.equal(
		isExpiredReservation(inviteReservationExpiry(now), now + 900001),
		true,
	);
});
