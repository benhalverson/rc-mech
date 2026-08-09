import { describe, expect, it } from 'vitest';
import type {
	MaintenanceCar,
	MaintenancePlan,
	ServiceRecord,
} from './maintenance.models';
import {
	maintenancePlanIsReadOnly,
	serviceRecordIsReadOnly,
} from './maintenance-read-only.rules';

const cars: MaintenanceCar[] = [
	{ id: 'active', name: 'Active', archivedAt: null },
	{ id: 'archived', name: 'Archived', archivedAt: '2026-08-01' },
];
const plan: MaintenancePlan = {
	id: 'plan-1',
	carId: 'active',
	componentId: null,
	name: 'Inspect',
	status: 'active',
};
const record: ServiceRecord = {
	id: 'record-1',
	carId: 'active',
	performedAt: '2026-08-01',
	description: 'Cleaned',
};

describe('maintenance read-only rules', () => {
	it('protects plans for archived cars and archived lifecycle state', () => {
		expect(maintenancePlanIsReadOnly(plan, cars)).toBe(false);
		expect(
			maintenancePlanIsReadOnly({ ...plan, carId: 'archived' }, cars),
		).toBe(true);
		expect(
			maintenancePlanIsReadOnly({ ...plan, status: 'archived' }, cars),
		).toBe(true);
	});

	it('protects records for archived cars and archived corrections', () => {
		expect(serviceRecordIsReadOnly(record, cars)).toBe(false);
		expect(
			serviceRecordIsReadOnly({ ...record, carId: 'archived' }, cars),
		).toBe(true);
		expect(
			serviceRecordIsReadOnly({ ...record, deletedAt: '2026-08-02' }, cars),
		).toBe(true);
	});
});
