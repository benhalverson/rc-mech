import { signal } from '@angular/core';
import { vi } from 'vitest';
import type {
	MaintenanceCar,
	MaintenanceComponent,
	MaintenancePlan,
	ServiceRecord,
} from './maintenance.models';
import type { MaintenanceMutationOutcome } from './maintenance-workspace-store';
export class FakeMaintenanceWorkspace {
	readonly available = signal(false);
	readonly cars = signal<MaintenanceCar[]>([]);
	readonly plans = signal<MaintenancePlan[]>([]);
	readonly records = signal<ServiceRecord[]>([]);
	readonly components = signal<MaintenanceComponent[]>([]);
	readonly timezone = signal('UTC');
	readonly syncMessage = signal('');
	readonly outcome = signal<MaintenanceMutationOutcome>({
		status: 'idle',
		requestId: null,
	});
	readonly mutate =
		vi.fn<
			(
				command: Readonly<{
					requestId: string;
					change: import('./maintenance-sync.models').MaintenanceCommand;
				}>,
			) => void
		>();
	readonly synchronize = vi.fn();
	readonly refresh = vi.fn();
}
export const maintenancePlanFixture: import('../../../../shared/maintenance-sync').PlanRecord =
	{
		id: 'plan',
		carId: 'car',
		componentId: null,
		name: 'Bearings',
		intervalDays: 7,
		intervalSessions: 2,
		intervalUnit: 'days',
		intervalValue: 7,
		baselineAt: '2026-10-01T12:00:00.000Z',
		baselineSessionCount: 0,
		status: 'active',
		pauseReason: null,
		pausedAt: null,
	};
export const maintenanceRecordFixture: import('../../../../shared/maintenance-sync').ServiceRecord =
	{
		id: 'record',
		carId: 'car',
		componentId: null,
		planId: 'plan',
		performedAt: '2026-10-09T12:00:00.000Z',
		description: 'Cleaned bearings',
		notes: null,
		cost: 10,
		currency: 'USD',
		baselineAt: '2026-10-09T12:00:00.000Z',
		baselineSessionCount: 2,
		previousBaselineAt: '2026-10-01T12:00:00.000Z',
		previousBaselineSessionCount: 0,
		deletedAt: null,
	};
export const maintenanceSnapshotFixture: import('./maintenance-sync.models').MaintenanceSnapshot =
	{
		collections: [
			{
				carId: 'car',
				version: 1,
				plans: [maintenancePlanFixture],
				records: [maintenanceRecordFixture],
			},
		],
		components: [
			{
				id: 'component',
				carId: 'car',
				slot: 'motor',
				name: 'Motor',
				removedAt: null,
			},
		],
		timezone: 'UTC',
	};
export const maintenanceOperationFixture = {
	ownerKey: 'owner',
	operationId: 'operation',
	carId: 'car',
	createdAt: '2026-10-09T12:00:00.000Z',
	sequence: 1,
	sessionCount: 2,
	dependencies: [],
	status: 'pending',
	command: {
		type: 'maintenance.change',
		entity: 'plan',
		action: 'save',
		carId: 'car',
		planId: 'plan',
		baseVersion: 1,
		base: null,
		input: {
			componentId: null,
			name: 'Bearings',
			intervalDays: 7,
			intervalSessions: 2,
			intervalUnit: 'days',
			intervalValue: 7,
			baselineAt: '2026-10-01T12:00:00.000Z',
			baselineSessionCount: 0,
		},
	},
} satisfies import('./maintenance-sync.models').MaintenanceOperation;
