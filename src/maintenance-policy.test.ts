import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
	addCalendarInterval,
	calculateMaintenanceDue,
	canTransitionMaintenance,
} from './maintenance-policy.ts';

const base = (
	overrides: Partial<Parameters<typeof calculateMaintenanceDue>[0]> = {},
) => ({
	status: 'active' as const,
	baselineAt: '2026-01-31T12:00:00.000Z',
	baselineSessionCount: 10,
	intervalUnit: 'months' as const,
	intervalValue: 1,
	intervalSessions: null,
	currentSessionCount: 10,
	now: '2026-02-28T12:00:00.000Z',
	timezone: 'UTC',
	...overrides,
});

test('calendar intervals support days, weeks, and clamped months', () => {
	assert.equal(
		addCalendarInterval('2026-01-01T12:00:00.000Z', 'days', 10, 'UTC'),
		'2026-01-11T00:00:00.000Z',
	);
	assert.equal(
		addCalendarInterval('2026-01-01T12:00:00.000Z', 'weeks', 2, 'UTC'),
		'2026-01-15T00:00:00.000Z',
	);
	assert.equal(
		addCalendarInterval('2026-01-31T12:00:00.000Z', 'months', 1, 'UTC'),
		'2026-02-28T00:00:00.000Z',
	);
});

test('date threshold is due and becomes overdue after its local date', () => {
	assert.equal(calculateMaintenanceDue(base()).dueStatus, 'due');
	assert.equal(
		calculateMaintenanceDue(base({ now: '2026-03-01T12:00:00.000Z' }))
			.dueStatus,
		'overdue',
	);
});

test('drive-session threshold is due independently', () => {
	const result = calculateMaintenanceDue(
		base({
			intervalSessions: 3,
			currentSessionCount: 13,
			now: '2026-01-02T12:00:00.000Z',
		}),
	);
	assert.deepEqual(result.dueReasons, ['drive-sessions']);
	assert.equal(result.isDue, true);
});

test('run-only plans do not acquire an implicit calendar threshold', () => {
	assert.equal(
		calculateMaintenanceDue({
			status: 'active',
			baselineAt: '2026-08-01T00:00:00.000Z',
			baselineSessionCount: 0,
			intervalUnit: 'none',
			intervalValue: 1,
			intervalSessions: 3,
			currentSessionCount: 1,
			now: '2026-08-10T00:00:00.000Z',
			timezone: 'UTC',
		}).dueStatus,
		'upcoming',
	);
});

test('combined plans are due when either threshold is reached', () => {
	const result = calculateMaintenanceDue(
		base({
			intervalSessions: 3,
			currentSessionCount: 13,
			now: '2026-01-02T12:00:00.000Z',
		}),
	);
	assert.equal(result.isDue, true);
	assert.deepEqual(result.dueReasons, ['drive-sessions']);
});

test('calendar calculations use the owner timezone', () => {
	const result = calculateMaintenanceDue(
		base({
			baselineAt: '2026-03-08T07:30:00.000Z',
			intervalUnit: 'days',
			intervalValue: 1,
			now: '2026-03-08T06:59:00.000Z',
			timezone: 'America/Los_Angeles',
		}),
	);
	assert.equal(result.dueStatus, 'upcoming');
});

test('paused and archived plans do not become due', () => {
	assert.equal(
		calculateMaintenanceDue(
			base({ status: 'paused', now: '2027-01-01T00:00:00.000Z' }),
		).dueStatus,
		'paused',
	);
	assert.equal(
		calculateMaintenanceDue(
			base({ status: 'archived', now: '2027-01-01T00:00:00.000Z' }),
		).isDue,
		false,
	);
});

test('maintenance lifecycle does not reopen archived plans', () => {
	assert.equal(canTransitionMaintenance('active', 'paused'), true);
	assert.equal(canTransitionMaintenance('paused', 'active'), true);
	assert.equal(canTransitionMaintenance('archived', 'active'), false);
});
