/**
 * Component commands, comparison bases, and queued outcomes shared by Build rules, storage, and HTTP replay.
 */

import type { CarSyncFeedback } from '../../garage/car-sync/car-sync.models';
import type { BuildComponentInput, InstalledComponent } from '../car.models';

export type BuildSyncCollection = Readonly<{
	carId: string;
	version: number;
	components: readonly InstalledComponent[];
}>;

export type BuildSyncCommand = Readonly<{
	action: 'install' | 'replace' | 'edit' | 'remove';
	carId: string;
	componentId: string | null;
	input: BuildComponentInput;
}>;

export type BuildSyncInput = BuildComponentInput &
	Readonly<{ slot: string; installedAt?: string }>;

export type BuildSyncWireCommand = Readonly<{
	type: 'build.change';
	action: BuildSyncCommand['action'];
	carId: string;
	componentId: string;
	baseVersion: number;
	base: InstalledComponent | null;
	input: BuildSyncInput;
}>;

export type BuildSyncOperation = Readonly<{
	operationId: string;
	ownerKey: string;
	carId: string;
	command: BuildSyncWireCommand;
	dependencies: readonly string[];
	status: 'pending' | 'needs-attention' | 'conflict';
	createdAt: string;
	sequence: number;
	feedback?: CarSyncFeedback;
	remote?: BuildSyncCollection;
}>;

export type BuildSyncView = Readonly<{
	canonicalCollections: readonly BuildSyncCollection[];
	collections: readonly BuildSyncCollection[];
	operations: readonly BuildSyncOperation[];
}>;

export type BuildSyncRemoteOutcome =
	| Readonly<{
			operationId: string;
			outcome: 'applied';
			collection: BuildSyncCollection;
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
			remote: BuildSyncCollection;
	  }>;
