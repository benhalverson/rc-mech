import type { GarageCar, GarageCarInput } from '../garage.models';

export const CAR_SYNC_CONTRACT_VERSION = 1;

export type CarEditableField = keyof GarageCarInput;
export type CarEditableBase = Partial<Record<CarEditableField, string | null>>;

export type CarSyncWireCommand =
	| Readonly<{
			type: 'car.create';
			carId: string;
			car: GarageCarInput;
	  }>
	| Readonly<{
			type: 'car.edit';
			carId: string;
			baseVersion: number;
			base: CarEditableBase;
			changes: Partial<GarageCarInput>;
	  }>
	| Readonly<{
			type: 'car.archive' | 'car.restore';
			carId: string;
			baseVersion: number;
			base: Readonly<{ archivedAt: string | null }>;
	  }>;

export type CarSyncCommand =
	| Readonly<{ type: 'create'; input: GarageCarInput }>
	| Readonly<{
			type: 'edit';
			carId: string;
			input: Partial<GarageCarInput>;
	  }>
	| Readonly<{ type: 'archive' | 'restore'; carId: string }>;

export type CarSyncFeedback = Readonly<{
	code: string;
	message: string;
	details?: Readonly<{
		formErrors?: readonly string[];
		fieldErrors?: Readonly<Record<string, readonly string[]>>;
	}>;
}>;

export type CarSyncOperation = Readonly<{
	operationId: string;
	ownerKey: string;
	carId: string;
	command: CarSyncWireCommand;
	dependencies: readonly string[];
	status: 'pending' | 'needs-attention' | 'conflict';
	createdAt: string;
	sequence?: number;
	feedback?: CarSyncFeedback;
	remote?: GarageCar;
}>;

export type CarSyncView = Readonly<{
	canonicalCars: readonly GarageCar[];
	cars: readonly GarageCar[];
	operations: readonly CarSyncOperation[];
}>;

export type CarSyncMark =
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
			remote: GarageCar;
	  }>;

export type CarSyncRemoteOutcome =
	| Readonly<{
			operationId: string;
			outcome: 'applied';
			car: GarageCar;
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
			remote: Readonly<{ car: GarageCar }>;
	  }>;

export type BuildCarSyncOperationContext = Readonly<{
	ownerKey: string;
	operationId: string;
	carId?: string;
	createdAt: string;
}>;

export type BuiltCarSyncOperation = Readonly<{
	operation: CarSyncOperation;
	car: GarageCar;
}>;
