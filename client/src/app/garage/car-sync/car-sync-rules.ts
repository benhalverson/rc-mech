import type { GarageCar, GarageCarInput } from '../garage.models';
import type {
	BuildCarSyncOperationContext,
	BuiltCarSyncOperation,
	CarEditableBase,
	CarEditableField,
	CarSyncCommand,
	CarSyncMark,
	CarSyncOperation,
} from './car-sync.models';

const editableFields: readonly CarEditableField[] = [
	'name',
	'make',
	'model',
	'scale',
	'vehicleType',
	'powerType',
	'notes',
];

const compareOperations = (
	left: CarSyncOperation,
	right: CarSyncOperation,
): number =>
	(left.sequence ?? 0) - (right.sequence ?? 0) ||
	left.createdAt.localeCompare(right.createdAt) ||
	left.operationId.localeCompare(right.operationId);

const nextSequence = (operations: readonly CarSyncOperation[]): number =>
	Math.max(0, ...operations.map((operation) => operation.sequence ?? 0)) + 1;

const applyOperation = (
	current: GarageCar | undefined,
	operation: CarSyncOperation,
): GarageCar | undefined => {
	const command = operation.command;
	if (command.type === 'car.create')
		return {
			id: command.carId,
			...command.car,
			archivedAt: null,
			createdAt: operation.createdAt,
			version: 0,
		};
	if (!current) return undefined;
	if (command.type === 'car.edit') return { ...current, ...command.changes };
	return {
		...current,
		archivedAt: command.type === 'car.archive' ? operation.createdAt : null,
	};
};

export const materializeCars = (
	canonicalCars: readonly GarageCar[],
	operations: readonly CarSyncOperation[],
): readonly GarageCar[] => {
	const cars = new Map(canonicalCars.map((car) => [car.id, car]));
	for (const operation of [...operations].sort(compareOperations)) {
		const next = applyOperation(cars.get(operation.carId), operation);
		if (next) cars.set(operation.carId, next);
	}
	return [...cars.values()];
};

const operationDependency = (
	carId: string,
	operations: readonly CarSyncOperation[],
): readonly string[] => {
	const previous = operations
		.filter((operation) => operation.carId === carId)
		.sort(compareOperations)
		.at(-1);
	return previous ? [previous.operationId] : [];
};

const editBase = (
	car: GarageCar,
	input: Partial<GarageCarInput>,
): CarEditableBase => {
	const base: CarEditableBase = {};
	for (const field of editableFields)
		if (input[field] !== undefined)
			Object.assign(base, { [field]: car[field] ?? null });
	return base;
};

export const buildCarSyncOperation = (
	command: CarSyncCommand,
	cars: readonly GarageCar[],
	operations: readonly CarSyncOperation[],
	context: BuildCarSyncOperationContext,
): BuiltCarSyncOperation => {
	if (command.type === 'create') {
		if (!context.carId) throw new Error('A stable Car identity is required');
		const operation: CarSyncOperation = {
			operationId: context.operationId,
			ownerKey: context.ownerKey,
			carId: context.carId,
			command: {
				type: 'car.create',
				carId: context.carId,
				car: command.input,
			},
			dependencies: operationDependency(context.carId, operations),
			status: 'pending',
			createdAt: context.createdAt,
			sequence: nextSequence(operations),
		};
		return {
			operation,
			car: applyOperation(undefined, operation) as GarageCar,
		};
	}

	const current = cars.find((car) => car.id === command.carId);
	if (!current) throw new Error('Car not found');
	const wireCommand =
		command.type === 'edit'
			? ({
					type: 'car.edit',
					carId: command.carId,
					baseVersion: current.version ?? 0,
					base: editBase(current, command.input),
					changes: command.input,
				} as const)
			: ({
					type: `car.${command.type}`,
					carId: command.carId,
					baseVersion: current.version ?? 0,
					base: { archivedAt: current.archivedAt ?? null },
				} as const);
	const operation: CarSyncOperation = {
		operationId: context.operationId,
		ownerKey: context.ownerKey,
		carId: command.carId,
		command: wireCommand,
		dependencies: operationDependency(command.carId, operations),
		status: 'pending',
		createdAt: context.createdAt,
		sequence: nextSequence(operations),
	};
	return {
		operation,
		car: applyOperation(current, operation) as GarageCar,
	};
};

export const rebaseCarSyncOperation = (
	operation: CarSyncOperation,
	completedOperationId: string,
	acknowledgedCar: GarageCar,
): CarSyncOperation => {
	if (!operation.dependencies.includes(completedOperationId)) return operation;
	const dependencies = operation.dependencies.filter(
		(dependency) => dependency !== completedOperationId,
	);
	if (operation.command.type === 'car.create')
		return { ...operation, dependencies };
	if (operation.command.type === 'car.edit') {
		const base = Object.fromEntries(
			Object.keys(operation.command.base).map((field) => [
				field,
				acknowledgedCar[field as CarEditableField] ?? null,
			]),
		) as CarEditableBase;
		return {
			...operation,
			dependencies,
			command: {
				...operation.command,
				baseVersion: acknowledgedCar.version ?? 0,
				base,
			},
		};
	}
	return {
		...operation,
		dependencies,
		command: {
			...operation.command,
			baseVersion: acknowledgedCar.version ?? 0,
			base: { archivedAt: acknowledgedCar.archivedAt ?? null },
		},
	};
};

export const readyCarSyncOperations = (
	operations: readonly CarSyncOperation[],
): readonly CarSyncOperation[] =>
	operations
		.filter(
			(operation) =>
				operation.status === 'pending' && operation.dependencies.length === 0,
		)
		.sort(compareOperations);

export const carSyncMark = (
	operations: readonly CarSyncOperation[],
	syncingOperationIds: ReadonlySet<string>,
): CarSyncMark => {
	const ordered = [...operations].sort(compareOperations);
	const conflict = ordered.find((operation) => operation.status === 'conflict');
	if (conflict?.remote)
		return {
			kind: 'conflict',
			operationId: conflict.operationId,
			remote: conflict.remote,
		};
	const attention = ordered.find(
		(operation) => operation.status === 'needs-attention',
	);
	if (attention?.feedback)
		return {
			kind: 'needs-attention',
			operationId: attention.operationId,
			feedback: attention.feedback,
		};
	const operationIds = ordered.map((operation) => operation.operationId);
	if (operationIds.some((operationId) => syncingOperationIds.has(operationId)))
		return { kind: 'syncing', operationIds };
	return operationIds.length
		? { kind: 'pending', operationIds }
		: { kind: 'synced' };
};
