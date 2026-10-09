/**
 * Maintenance editor intents and durable operation/view types, separating a captured local command from its canonical acknowledgement.
 */

import type {
	MaintenanceChange,
	MaintenanceCollection,
} from '../../../../shared/maintenance-sync';
import type { CarSyncFeedback } from '../garage/car-sync/car-sync.models';
import type { ConsumableCommand } from './consumables/consumable-store';
import type { MaintenanceComponent } from './maintenance.models';
import type { MaintenancePlanCommand } from './maintenance-plan-store';
import type { ServiceRecordCommand } from './service-record-store';
export type MaintenanceCommand =
	| MaintenancePlanCommand
	| ServiceRecordCommand
	| ConsumableCommand;
export type MaintenanceSnapshot = Readonly<{
	collections: readonly MaintenanceCollection[];
	components: readonly MaintenanceComponent[];
	timezone: string;
}>;
export type MaintenanceOperation = Readonly<{
	ownerKey: string;
	operationId: string;
	carId: string;
	command: MaintenanceChange;
	createdAt: string;
	sessionCount: number;
	sequence: number;
	dependencies: readonly string[];
	status: 'pending' | 'needs-attention' | 'conflict';
	feedback?: CarSyncFeedback;
	remote?: MaintenanceCollection;
}>;
export type MaintenanceView = Readonly<{
	canonical: MaintenanceSnapshot;
	current: MaintenanceSnapshot;
	operations: readonly MaintenanceOperation[];
}>;
export type MaintenanceRemoteOutcome =
	| Readonly<{
			operationId: string;
			outcome: 'applied';
			collection: MaintenanceCollection;
	  }>
	| Readonly<{
			operationId: string;
			outcome: 'rejected';
			error: CarSyncFeedback;
	  }>
	| Readonly<{
			operationId: string;
			outcome: 'conflict';
			error: CarSyncFeedback;
			remote: MaintenanceCollection;
	  }>;
