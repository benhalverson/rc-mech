import { describe, expect, test } from 'vitest';
import {
	applyMaintenanceChange,
	type MaintenanceChange,
	type MaintenanceCollection,
	maintenanceBaseMatches,
	type PlanRecord,
	type ServiceRecord,
} from '../shared/maintenance-sync';

const now = '2026-10-09T12:00:00.000Z';
const earlier = '2026-10-01T12:00:00.000Z';
const plan: PlanRecord = {
	id: 'plan',
	carId: 'car',
	componentId: null,
	name: 'Bearings',
	intervalDays: 7,
	intervalSessions: 3,
	intervalUnit: 'days',
	intervalValue: 7,
	baselineAt: earlier,
	baselineSessionCount: 1,
	status: 'active',
	pauseReason: null,
	pausedAt: null,
};
const record: ServiceRecord = {
	id: 'record',
	carId: 'car',
	planId: 'plan',
	componentId: null,
	performedAt: now,
	description: 'Done',
	notes: null,
	cost: null,
	currency: null,
	baselineAt: now,
	baselineSessionCount: 3,
	previousBaselineAt: earlier,
	previousBaselineSessionCount: 1,
	deletedAt: null,
};
const collection: MaintenanceCollection = {
	carId: 'car',
	version: 1,
	plans: [plan],
	records: [record],
};
const command: Extract<MaintenanceChange, { entity: 'service' }> = {
	type: 'maintenance.change',
	entity: 'service',
	action: 'save',
	recordId: 'record',
	carId: 'car',
	baseVersion: 1,
	base: record,
	planBase: plan,
	baselineSessionCount: 3,
	input: {
		componentId: null,
		performedAt: now,
		description: 'Changed',
		notes: null,
		cost: null,
		currency: null,
	},
};
describe('shared maintenance history rules', () => {
	test('compares complete saved bases including absence', () => {
		expect(maintenanceBaseMatches(null, null)).toBe(true);
		expect(maintenanceBaseMatches(plan, null)).toBe(false);
		expect(maintenanceBaseMatches(null, plan)).toBe(false);
		expect(maintenanceBaseMatches(plan, { ...plan })).toBe(true);
		expect(maintenanceBaseMatches(plan, { ...plan, name: 'remote' })).toBe(
			false,
		);
	});
	test('preserves capture-time usage and history identity across completion and later sessions', () => {
		const changed = applyMaintenanceChange(
			{ ...collection, records: [] },
			{ ...command, base: null },
			now,
			3,
		);
		expect(changed.plans[0].baselineSessionCount).toBe(3);
		expect(changed.records[0].previousBaselineSessionCount).toBe(1);
		expect(changed.records[0].id).toBe('record');
		const edited = applyMaintenanceChange(
			changed,
			{
				...command,
				base: changed.records[0],
				planBase: changed.plans[0],
				input: { ...command.input, performedAt: earlier },
			},
			now,
			9,
		);
		expect(edited.records).toHaveLength(1);
		expect(edited.records[0].baselineSessionCount).toBe(3);
		expect(edited.plans[0].baselineAt).toBe(earlier);
	});
	test('undoes and restores only the current baseline and preserves independent later work', () => {
		const completed = { ...plan, baselineAt: now, baselineSessionCount: 3 };
		const undone = applyMaintenanceChange(
			{ ...collection, plans: [completed] },
			{ ...command, action: 'archive', planBase: completed },
			now,
			3,
		);
		expect(undone.plans[0].baselineAt).toBe(earlier);
		expect(undone.records[0].deletedAt).toBe(now);
		const restored = applyMaintenanceChange(
			undone,
			{
				...command,
				action: 'restore',
				base: undone.records[0],
				planBase: undone.plans[0],
			},
			now,
			8,
		);
		expect(restored.plans[0].baselineAt).toBe(now);
		expect(restored.plans[0].baselineSessionCount).toBe(3);
		const later = { ...plan, baselineAt: '2026-10-10T12:00:00.000Z' };
		for (const action of ['archive', 'restore', 'save'] as const)
			expect(
				applyMaintenanceChange(
					{ ...collection, plans: [later] },
					{ ...command, action, planBase: later },
					now,
					8,
				).plans[0],
			).toEqual(later);
		const noPrevious = {
			...record,
			previousBaselineAt: null,
			previousBaselineSessionCount: null,
			baselineSessionCount: null,
		};
		expect(
			applyMaintenanceChange(
				{ ...collection, plans: [completed] },
				{
					...command,
					action: 'archive',
					base: noPrevious,
					planBase: completed,
				},
				now,
				8,
			).plans[0],
		).toEqual(completed);
		expect(
			applyMaintenanceChange(
				collection,
				{
					...command,
					action: 'restore',
					base: { ...noPrevious, previousBaselineAt: earlier },
				},
				now,
				8,
			).plans[0].baselineSessionCount,
		).toBe(0);
		expect(
			applyMaintenanceChange(
				{ ...collection, plans: [completed] },
				{
					...command,
					action: 'archive',
					base: { ...noPrevious, previousBaselineAt: earlier },
					planBase: completed,
				},
				now,
				8,
			).plans[0].baselineSessionCount,
		).toBe(0);
	});
	test('retains ad-hoc service fields and handles empty local intent without inventing a plan', () => {
		const changed = applyMaintenanceChange(
			{ carId: 'car', version: 0, plans: [], records: [] },
			{ ...command, base: null, planBase: null },
			now,
			0,
		);
		expect(changed.records[0]).toMatchObject({
			planId: null,
			baselineSessionCount: null,
			previousBaselineAt: null,
		});
		expect(
			applyMaintenanceChange(
				collection,
				{ ...command, action: 'archive', base: null, planBase: null },
				now,
				0,
			).records[0].deletedAt,
		).toBe(now);
	});
	test('preserves plan fields through transitions and an existing pause date', () => {
		const { id, carId, status, pauseReason, pausedAt, ...input } = plan;
		const change: Extract<MaintenanceChange, { entity: 'plan' }> = {
			type: 'maintenance.change',
			entity: 'plan',
			carId,
			planId: id,
			baseVersion: 1,
			action: 'save',
			base: plan,
			input,
		};
		for (const action of ['pause', 'resume', 'archive', 'restore'] as const) {
			const next = applyMaintenanceChange(
				collection,
				{ ...change, action, input: { ...input, name: 'ignored' } },
				now,
				0,
			);
			expect(next.plans[0].name).toBe(plan.name);
		}
		expect(
			applyMaintenanceChange(
				collection,
				{
					...change,
					action: 'pause',
					base: { ...plan, status: 'paused', pausedAt: earlier },
				},
				now,
				0,
			).plans[0].pausedAt,
		).toBe(earlier);
		expect(
			applyMaintenanceChange(
				collection,
				{ ...change, base: { ...plan, status: 'paused', pausedAt: earlier } },
				now,
				0,
			).plans[0].status,
		).toBe('paused');
		expect(
			applyMaintenanceChange(collection, { ...change, base: null }, now, 0)
				.plans[0].status,
		).toBe('active');
		expect(
			applyMaintenanceChange(
				collection,
				{ ...change, action: 'pause', base: null },
				now,
				0,
			).plans[0].name,
		).toBe(plan.name);
	});
});

test('materializes Consumable intent against an older snapshot without losing its stable identity', () => {
	const change: MaintenanceChange = {
		type: 'maintenance.change',
		entity: 'consumable',
		carId: 'car',
		baseVersion: 0,
		entryId: 'entry',
		action: 'archive',
		base: null,
		input: {
			kind: 'tires',
			performedAt: now,
			fluidArea: null,
			customFluidArea: null,
			frontDetails: '{"details":"Pins"}',
			frontCost: null,
			frontCurrency: null,
			rearDetails: null,
			rearCost: null,
			rearCurrency: null,
			cost: null,
			currency: null,
			notes: null,
		},
	};
	const result = applyMaintenanceChange(
		{ carId: 'car', version: 0, plans: [], records: [] },
		change,
		now,
		0,
	);
	expect(result.consumables).toEqual([
		expect.objectContaining({ id: 'entry', archivedAt: now }),
	]);
});
