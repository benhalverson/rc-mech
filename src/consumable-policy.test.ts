import assert from 'node:assert/strict';
import test from 'node:test';
import {
	canArchiveConsumable,
	canEditConsumable,
	canRestoreConsumable,
	mapSetupTiresToAxles,
	ownsConsumable,
} from './consumable-policy.ts';
import { consumableInput } from './types.ts';

const date = '2026-08-05T00:00:00.000Z';

test('consumable lifecycle supports archive and restore without deleting history', () => {
	assert.equal(ownsConsumable('car-1', 'car-1'), true);
	assert.equal(ownsConsumable('car-2', 'car-1'), false);
	assert.equal(ownsConsumable(null, 'car-1'), false);
	assert.equal(canEditConsumable({ archivedAt: null }), true);
	assert.equal(canArchiveConsumable({ archivedAt: null }), true);
	assert.equal(canEditConsumable({ archivedAt: date }), false);
	assert.equal(canArchiveConsumable({ archivedAt: date }), false);
	assert.equal(canRestoreConsumable({ archivedAt: date }), true);
	assert.equal(canRestoreConsumable({ archivedAt: null }), false);
});

test('tire input supports front, rear, or both independent axle snapshots', () => {
	for (const value of [
		{
			kind: 'tires',
			performedAt: date,
			front: { details: '2.2 compound', cost: 30, currency: 'usd' },
		},
		{
			kind: 'tires',
			performedAt: date,
			rear: { details: '2.4 compound', cost: 32, currency: 'USD' },
		},
		{
			kind: 'tires',
			performedAt: date,
			front: { details: 'front' },
			rear: { details: 'rear', cost: 40, currency: 'eur' },
		},
	])
		assert.equal(consumableInput.safeParse(value).success, true);
	assert.equal(
		consumableInput.safeParse({ kind: 'tires', performedAt: date }).success,
		false,
	);
	assert.equal(
		consumableInput.safeParse({
			kind: 'tires',
			performedAt: date,
			front: { cost: 3 },
		}).success,
		false,
	);
});

test('fluid input preserves supported areas and optional paired cost', () => {
	assert.equal(
		consumableInput.safeParse({
			kind: 'fluid',
			performedAt: date,
			fluidArea: 'front-shocks',
			notes: 'bleed',
		}).success,
		true,
	);
	assert.equal(
		consumableInput.safeParse({
			kind: 'fluid',
			performedAt: date,
			fluidArea: 'custom',
			customFluidArea: 'center diff',
			cost: 8,
			currency: 'usd',
		}).success,
		true,
	);
	assert.equal(
		consumableInput.safeParse({
			kind: 'fluid',
			performedAt: date,
			fluidArea: 'custom',
		}).success,
		false,
	);
	assert.equal(
		consumableInput.safeParse({
			kind: 'fluid',
			performedAt: date,
			fluidArea: 'rear-shocks',
			cost: 8,
		}).success,
		false,
	);
});

test('setup tire mapping keeps front and rear details distinct and falls back to shared setup tires', () => {
	assert.deepEqual(
		mapSetupTiresToAxles({
			front: { compound: 'soft' },
			rear: { compound: 'medium' },
		}),
		{ front: { compound: 'soft' }, rear: { compound: 'medium' } },
	);
	assert.deepEqual(
		mapSetupTiresToAxles({ compound: 'medium', insert: 'yellow' }),
		{
			front: { compound: 'medium', insert: 'yellow' },
			rear: { compound: 'medium', insert: 'yellow' },
		},
	);
	assert.deepEqual(mapSetupTiresToAxles(null), { front: null, rear: null });
});
