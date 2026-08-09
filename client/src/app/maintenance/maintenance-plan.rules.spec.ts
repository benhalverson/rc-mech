import { describe, expect, it } from 'vitest';
import type { MaintenancePlan } from './maintenance.models';
import {
	calculatePlanState,
	calendarDays,
	filterMaintenancePlans,
} from './maintenance-plan.rules';

const plan: MaintenancePlan = {
	id: 'plan-1',
	carId: 'car-1',
	componentId: null,
	name: 'Inspect',
	intervalDays: 30,
	intervalSessions: 5,
	baselineAt: '2026-07-01T00:00:00.000Z',
	baselineSessionCount: 0,
	status: 'active',
};

describe('maintenance plan rules', () => {
	it('converts supported calendar units', () => {
		expect(calendarDays(2, 'weeks')).toBe(14);
		expect(calendarDays(1, 'months')).toBe(30);
		expect(calendarDays(3, 'days')).toBe(3);
	});

	it('derives every due and lifecycle state', () => {
		expect(calculatePlanState({ ...plan, dueStatus: 'due' })).toBe('due');
		expect(calculatePlanState({ ...plan, status: 'archived' })).toBe(
			'archived',
		);
		expect(calculatePlanState({ ...plan, status: 'paused' })).toBe('paused');
		expect(
			calculatePlanState(
				{ ...plan, intervalSessions: null },
				new Date('2026-07-15T00:00:00.000Z'),
			),
		).toBe('upcoming');
		expect(
			calculatePlanState(
				{ ...plan, intervalDays: null },
				new Date('2026-07-02T00:00:00.000Z'),
				5,
			),
		).toBe('due');
		expect(
			calculatePlanState(
				{ ...plan, nextDueAt: '2026-08-03T00:00:00.000Z' },
				new Date('2026-08-01T00:00:00.000Z'),
			),
		).toBe('due');
		expect(
			calculatePlanState(
				{ ...plan, nextDueAt: '2026-07-31T00:00:00.000Z' },
				new Date('2026-08-01T00:00:00.000Z'),
			),
		).toBe('overdue');
		expect(calculatePlanState(plan, new Date('2026-08-02T00:00:00.000Z'))).toBe(
			'overdue',
		);
		expect(
			calculatePlanState(
				{
					...plan,
					baselineAt: null,
					intervalDays: null,
					baselineSessionCount: undefined,
				},
				new Date('2026-07-02T00:00:00.000Z'),
				5,
			),
		).toBe('due');
	});

	it('filters plans through the shared view rule', () => {
		expect(filterMaintenancePlans([plan], 'all')).toEqual([plan]);
		expect(filterMaintenancePlans([plan], 'paused')).toEqual([]);
	});
});
