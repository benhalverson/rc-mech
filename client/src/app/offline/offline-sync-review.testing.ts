import { buildBuildSyncOperation } from '../car/build-sync/build-sync-rules';
import { buildDriveSyncOperation } from '../car/drive-sync/drive-sync-rules';
import type { SetupSnapshot } from '../car/setups/setup-snapshot';
import { tireRecord } from '../maintenance/consumables/consumable-sync.testing';
import {
	maintenanceOperationFixture,
	maintenanceRecordFixture,
	maintenanceSnapshotFixture,
} from '../maintenance/maintenance-sync.testing';
import type { SyncReview } from './offline-sync-review.models';

const common = {
	ownerKey: 'user-a',
	operationId: 'review',
	carId: 'car',
	status: 'conflict' as const,
	createdAt: '2026-10-09',
	sequence: 1,
	dependencies: [],
	feedback: { code: 'CONFLICT', message: 'Changed on another device.' },
};
const build = buildBuildSyncOperation(
	{
		action: 'install',
		carId: 'car',
		componentId: null,
		input: { slot: 'motor', name: 'Device motor' },
	},
	[],
	[],
	{ ...common, componentId: 'component', carDependencies: [] },
);
const drive = buildDriveSyncOperation(
	{
		action: 'save',
		carId: 'car',
		sessionId: null,
		input: {
			startedAt: '2026-10-09T12:00:00Z',
			durationMinutes: 10,
			conditions: 'Dry',
			notes: 'Device notes',
		},
	},
	[],
	[],
	{ ...common, sessionId: 'drive', carDependencies: [] },
);
export const reviewedSetup: SetupSnapshot = {
	id: 'setup',
	carId: 'car',
	name: 'Saved setup',
	sections: {
		vehicle: {},
		drivetrain: {},
		electronics: {},
		tires: {},
		shocks: {},
		frontSuspension: {},
		rearSuspension: {},
		notes: {},
	},
	version: 4,
};
export const syncReviewFixtures: readonly SyncReview[] = [
	{
		family: 'car',
		operation: {
			...common,
			command: {
				type: 'car.edit',
				carId: 'car',
				baseVersion: 1,
				base: { name: 'Original' },
				changes: { name: 'Device name' },
			},
			remote: { id: 'car', name: 'Saved name', version: 3 },
		},
	},
	{
		family: 'setup',
		operation: {
			...common,
			setupId: 'setup',
			command: {
				type: 'setup.correct',
				carId: 'car',
				setupId: 'setup',
				baseVersion: 1,
				base: { name: 'Original', notes: null },
				changes: { name: 'Device setup' },
			},
			remote: {
				setup: reviewedSetup,
				currentSetupId: 'setup',
				currentSetupVersion: 5,
			},
		},
	},
	{
		family: 'build',
		operation: {
			...build.operation,
			...common,
			remote: { ...build.collection, version: 4 },
		},
	},
	{
		family: 'drive',
		operation: {
			...drive.operation,
			...common,
			remote: { ...drive.collection, version: 4 },
		},
	},
	{
		family: 'maintenance',
		operation: {
			...maintenanceOperationFixture,
			...common,
			remote: { ...maintenanceSnapshotFixture.collections[0], version: 4 },
		},
	},
	{
		family: 'settings',
		operation: {
			...common,
			feedback: 'Timezone changed elsewhere.',
			command: { type: 'timezone', base: 'UTC', timezone: 'Europe/London' },
			remote: 'America/New_York',
		},
	},
	{
		family: 'maintenance',
		operation: {
			...maintenanceOperationFixture,
			...common,
			command: {
				type: 'maintenance.change',
				entity: 'service',
				baselineSessionCount: 2,
				planBase: null,
				action: 'save',
				carId: 'car',
				recordId: 'record',
				baseVersion: 1,
				base: null,
				input: maintenanceRecordFixture,
			},
			remote: { ...maintenanceSnapshotFixture.collections[0], version: 4 },
		},
	},
	{
		family: 'maintenance',
		operation: {
			...maintenanceOperationFixture,
			...common,
			command: {
				type: 'maintenance.change',
				entity: 'consumable',
				action: 'save',
				carId: 'car',
				entryId: 'tire',
				baseVersion: 1,
				base: null,
				input: tireRecord,
			},
			remote: {
				...maintenanceSnapshotFixture.collections[0],
				version: 4,
				consumables: [tireRecord],
			},
		},
	},
];
