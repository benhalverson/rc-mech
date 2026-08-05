import assert from 'node:assert/strict';
import test from 'node:test';
import {
	calculateConsumableReport,
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

test('report keeps front, rear, and both axle events independent', () => {
	const report = calculateConsumableReport([
		{
			id: 'front-only',
			kind: 'tires',
			performedAt: '2026-01-01T00:00:00.000Z',
			front: { details: 'front', cost: 20, currency: 'USD' },
		},
		{
			id: 'both',
			kind: 'tires',
			performedAt: '2026-02-01T00:00:00.000Z',
			front: { details: 'front-new', cost: 25, currency: 'USD' },
			rear: { details: 'rear-new', cost: 30, currency: 'USD' },
		},
		{
			id: 'rear-only',
			kind: 'tires',
			performedAt: '2026-03-01T00:00:00.000Z',
			rear: { details: 'rear-latest', cost: 35, currency: 'USD' },
		},
	]);
	assert.equal(report.tires.latestFront?.id, 'both');
	assert.equal(report.tires.latestRear?.id, 'rear-only');
	assert.equal(report.tires.frequency.front.eventCount, 2);
	assert.equal(report.tires.frequency.rear.eventCount, 2);
	assert.equal(report.tires.frequency.front.status, 'calculated');
	assert.equal(report.tires.frequency.rear.status, 'calculated');
	assert.equal(report.tires.spend.front.total, 45);
	assert.equal(report.tires.spend.rear.total, 65);
	assert.equal(report.tires.spend.combined.total, 110);
});

test('report marks missing axle costs without inventing spend', () => {
	const report = calculateConsumableReport([
		{
			kind: 'tires',
			performedAt: '2026-04-01T00:00:00.000Z',
			frontDetails: JSON.stringify({ compound: 'soft' }),
			frontCost: null,
			frontCurrency: null,
			rearDetails: JSON.stringify({ compound: 'medium' }),
			rearCost: 40,
			rearCurrency: 'USD',
		},
	]);
	assert.equal(report.tires.spend.front.total, 0);
	assert.equal(report.tires.spend.front.isIncomplete, true);
	assert.equal(report.tires.spend.rear.total, 40);
	assert.equal(report.tires.spend.combined.total, 40);
	assert.equal(report.tires.spend.combined.isIncomplete, true);
});

test('report includes fluid service areas and excludes archived history', () => {
	const report = calculateConsumableReport([
		{
			id: 'fluid-1',
			kind: 'fluid',
			performedAt: '2026-05-01T00:00:00.000Z',
			fluidArea: 'front-shocks',
		},
		{
			id: 'fluid-2',
			kind: 'fluid',
			performedAt: '2026-06-01T00:00:00.000Z',
			fluidArea: 'custom',
			customFluidArea: 'center diff',
		},
		{
			id: 'archived',
			kind: 'fluid',
			performedAt: '2026-07-01T00:00:00.000Z',
			fluidArea: 'rear-shocks',
			archivedAt: '2026-07-02T00:00:00.000Z',
		},
	]);
	assert.deepEqual(report.fluidHistory, [
		{
			id: 'fluid-2',
			area: 'custom',
			customArea: 'center diff',
			lastChangedAt: '2026-06-01T00:00:00.000Z',
		},
		{
			id: 'fluid-1',
			area: 'front-shocks',
			customArea: null,
			lastChangedAt: '2026-05-01T00:00:00.000Z',
		},
	]);
});
