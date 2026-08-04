import assert from 'node:assert/strict';
import test from 'node:test';
import {
	canDeleteDriveSession,
	canEditDriveSession,
	isIanaTimezone,
	presentDateTime,
} from './drive-session-policy.ts';

test('timezone policy accepts IANA zones and rejects arbitrary values', () => {
	assert.equal(isIanaTimezone('America/Los_Angeles'), true);
	assert.equal(isIanaTimezone('UTC'), true);
	assert.equal(isIanaTimezone('PST'), false);
	assert.equal(isIanaTimezone('GMT'), false);
	assert.equal(isIanaTimezone('not/a-timezone'), false);
});

test('session lifecycle makes soft-deleted sessions immutable', () => {
	assert.equal(canEditDriveSession({ deletedAt: null }), true);
	assert.equal(canDeleteDriveSession({ deletedAt: null }), true);
	assert.equal(
		canEditDriveSession({ deletedAt: '2026-08-03T00:00:00.000Z' }),
		false,
	);
	assert.equal(
		canDeleteDriveSession({ deletedAt: '2026-08-03T00:00:00.000Z' }),
		false,
	);
});

test('date presentation is stable for the configured timezone', () => {
	assert.deepEqual(
		presentDateTime('2026-08-03T07:30:05.000Z', 'America/Los_Angeles'),
		{
			localDate: '2026-08-03',
			localTime: '00:30:05',
			timezone: 'America/Los_Angeles',
		},
	);
});
