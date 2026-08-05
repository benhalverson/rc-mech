import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
	canDeleteServiceRecord,
	canEditServiceRecord,
	shouldRestoreBaseline,
} from './service-policy.ts';
import { serviceRecordInput } from './types.ts';

test('service records become immutable after soft deletion', () => {
	assert.equal(canEditServiceRecord({ deletedAt: null }), true);
	assert.equal(canDeleteServiceRecord({ deletedAt: null }), true);
	assert.equal(
		canEditServiceRecord({ deletedAt: '2026-08-03T00:00:00.000Z' }),
		false,
	);
	assert.equal(
		canDeleteServiceRecord({ deletedAt: '2026-08-03T00:00:00.000Z' }),
		false,
	);
});

test('baseline rollback only applies while the completion remains current', () => {
	const record = {
		planId: 'plan-1',
		baselineAt: '2026-08-03T00:00:00.000Z',
		previousBaselineAt: '2026-08-01T00:00:00.000Z',
	};
	assert.equal(
		shouldRestoreBaseline(record, { baselineAt: record.baselineAt }),
		true,
	);
	assert.equal(
		shouldRestoreBaseline(record, { baselineAt: '2026-08-04T00:00:00.000Z' }),
		false,
	);
	assert.equal(
		shouldRestoreBaseline(
			{ ...record, planId: null },
			{ baselineAt: record.baselineAt },
		),
		false,
	);
});

test('service input requires work details and paired cost data', () => {
	const base = { carId: 'car-1', performedAt: '2026-08-03T00:00:00.000Z' };
	assert.equal(
		serviceRecordInput.safeParse({ ...base, notes: 'Diff correction' }).success,
		true,
	);
	assert.equal(
		serviceRecordInput.safeParse({ ...base, description: 'Repair', cost: 10 })
			.success,
		false,
	);
	assert.equal(
		serviceRecordInput.safeParse({
			...base,
			description: 'Repair',
			cost: 10,
			currency: 'usd',
		}).success,
		true,
	);
});
