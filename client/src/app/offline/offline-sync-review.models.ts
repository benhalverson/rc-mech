import type { BuildSyncOperation } from '../car/build-sync/build-sync.models';
import type { DriveSyncOperation } from '../car/drive-sync/drive-sync.models';
import type { SetupSyncOperation } from '../car/setups/setup-sync.models';
import type { CarSyncOperation } from '../garage/car-sync/car-sync.models';
import type { MaintenanceOperation } from '../maintenance/maintenance-sync.models';
import type { SettingsOperation } from '../settings/settings-sync.models';
export type ReviewOperations = {
	car: CarSyncOperation;
	setup: SetupSyncOperation;
	build: BuildSyncOperation;
	drive: DriveSyncOperation;
	maintenance: MaintenanceOperation;
	settings: SettingsOperation;
};
export type ReviewFamily = keyof ReviewOperations;
export type SyncReview = {
	[F in ReviewFamily]: Readonly<{ family: F; operation: ReviewOperations[F] }>;
}[ReviewFamily];
export type ReviewOperation = ReviewOperations[ReviewFamily];
export type ReviewDecision = 'device' | 'remote';
