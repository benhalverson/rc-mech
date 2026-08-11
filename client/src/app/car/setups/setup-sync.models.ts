import type { CarSyncFeedback } from '../../garage/car-sync/car-sync.models';
import type { SetupSnapshot, SetupSnapshotDraft } from './setup-snapshot';

export type SetupCurrentSelection = Readonly<{
	setupId: string | null;
	version: number;
}>;

export type SetupSyncCollection = Readonly<{
	carId: string;
	currentSetupId: string | null;
	currentSetupVersion: number;
	setups: readonly SetupSnapshot[];
}>;

export type SetupSyncDraft = Omit<SetupSnapshotDraft, 'makeCurrent'>;
export type SetupCorrectionBase = Readonly<Record<string, unknown>>;

export type SetupSyncWireCommand =
	| Readonly<{
			type: 'setup.create';
			carId: string;
			setupId: string;
			copiedFromSetupId: string | null;
			setup: SetupSyncDraft;
			makeCurrent: boolean;
			baseCurrent: SetupCurrentSelection | null;
	  }>
	| Readonly<{
			type: 'setup.correct';
			carId: string;
			setupId: string;
			baseVersion: number;
			base: SetupCorrectionBase;
			changes: SetupSyncDraft;
	  }>
	| Readonly<{
			type: 'setup.select-current';
			carId: string;
			setupId: string;
			baseCurrent: SetupCurrentSelection;
	  }>;

export type SetupSyncCommand =
	| Readonly<{
			type: 'create';
			carId: string;
			draft: SetupSnapshotDraft;
	  }>
	| Readonly<{
			type: 'copy';
			carId: string;
			setupId: string;
	  }>
	| Readonly<{
			type: 'change';
			carId: string;
			setupId: string;
			draft: SetupSnapshotDraft;
	  }>
	| Readonly<{
			type: 'correct';
			carId: string;
			setupId: string;
			draft: SetupSnapshotDraft;
	  }>
	| Readonly<{
			type: 'select-current';
			carId: string;
			setupId: string;
	  }>;

export type SetupSyncOperation = Readonly<{
	operationId: string;
	ownerKey: string;
	carId: string;
	setupId: string;
	command: SetupSyncWireCommand;
	dependencies: readonly string[];
	status: 'pending' | 'needs-attention' | 'conflict';
	createdAt: string;
	sequence: number;
	feedback?: CarSyncFeedback;
	remote?: SetupSyncConflictRemote;
}>;

export type SetupSyncView = Readonly<{
	canonicalCollections: readonly SetupSyncCollection[];
	collections: readonly SetupSyncCollection[];
	operations: readonly SetupSyncOperation[];
}>;

export type SetupSyncConflictRemote = Readonly<{
	currentSetupId: string | null;
	currentSetupVersion: number;
	setup: SetupSnapshot | null;
}>;

export type SetupSyncRemoteOutcome =
	| Readonly<{
			operationId: string;
			outcome: 'applied';
			setup: SetupSnapshot;
			currentSetupId: string | null;
			currentSetupVersion: number;
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
			remote: SetupSyncConflictRemote;
	  }>;

export type SetupSyncMark =
	| Readonly<{ kind: 'synced' }>
	| Readonly<{ kind: 'pending'; operationIds: readonly string[] }>
	| Readonly<{ kind: 'syncing'; operationIds: readonly string[] }>
	| Readonly<{
			kind: 'needs-attention';
			operationId: string;
			feedback: CarSyncFeedback;
	  }>
	| Readonly<{
			kind: 'conflict';
			operationId: string;
			remote: SetupSyncConflictRemote;
	  }>;

export type BuildSetupSyncOperationContext = Readonly<{
	ownerKey: string;
	operationId: string;
	setupId?: string;
	createdAt: string;
	carDependencies?: readonly string[];
}>;

export type BuiltSetupSyncOperation = Readonly<{
	operation: SetupSyncOperation;
	setup: SetupSnapshot;
	collection: SetupSyncCollection;
}>;
