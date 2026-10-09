/**
 * Drive history and stable queued-operation shapes shared by local usage, storage, and replay.
 */

import type { CarSyncFeedback } from '../../garage/car-sync/car-sync.models';
import type {
	DriveSession,
	DriveSessionDraft,
} from '../drive-sessions/drive-session.models';

export type DriveSyncCollection = Readonly<{
	carId: string;
	version: number;
	timezone?: string;
	sessions: readonly DriveSession[];
}>;
export type DriveSyncCommand = Readonly<{
	action: 'save' | 'archive';
	carId: string;
	sessionId: string | null;
	input: DriveSessionDraft;
}>;
export type DriveSyncWireCommand = Readonly<{
	type: 'drive.change';
	action: DriveSyncCommand['action'];
	carId: string;
	sessionId: string;
	baseVersion: number;
	base: DriveSession | null;
	input: DriveSessionDraft;
}>;
export type DriveSyncOperation = Readonly<{
	operationId: string;
	ownerKey: string;
	carId: string;
	command: DriveSyncWireCommand;
	dependencies: readonly string[];
	status: 'pending' | 'needs-attention' | 'conflict';
	createdAt: string;
	sequence: number;
	feedback?: CarSyncFeedback;
	remote?: DriveSyncCollection;
}>;
export type DriveSyncView = Readonly<{
	canonicalCollections: readonly DriveSyncCollection[];
	collections: readonly DriveSyncCollection[];
	operations: readonly DriveSyncOperation[];
}>;
export type DriveSyncRemoteOutcome =
	| Readonly<{
			operationId: string;
			outcome: 'applied';
			collection: DriveSyncCollection;
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
			remote: DriveSyncCollection;
	  }>;
