/**
 * Pure Drive-session working-copy and replay rules used by storage and the Car
 * workspace. Keep optimistic materialization, dependency selection, and post-ack
 * rebasing deterministic and independent of IndexedDB/HTTP side effects.
 */

import type {
	DriveSyncCollection,
	DriveSyncCommand,
	DriveSyncOperation,
	DriveSyncWireCommand,
} from './drive-sync.models';

export const applyDriveChange = (
	collection: DriveSyncCollection,
	command: DriveSyncWireCommand,
	createdAt: string,
): DriveSyncCollection => {
	const session = {
		...command.input,
		id: command.sessionId,
		carId: command.carId,
		deletedAt: command.action === 'archive' ? createdAt : null,
	};
	const sessions = collection.sessions.some((value) => value.id === session.id)
		? collection.sessions.map((value) =>
				value.id === session.id ? session : value,
			)
		: [...collection.sessions, session];
	return { ...collection, version: collection.version + 1, sessions };
};
export const materializeDriveCollections = (
	canonical: readonly DriveSyncCollection[],
	operations: readonly DriveSyncOperation[],
): readonly DriveSyncCollection[] => {
	const collections = new Map(
		canonical.map((collection) => [collection.carId, collection]),
	);
	for (const operation of [...operations].sort(
		(a, b) => a.sequence - b.sequence,
	)) {
		const current = collections.get(operation.carId) ?? {
			carId: operation.carId,
			version: 0,
			sessions: [],
		};
		collections.set(
			operation.carId,
			applyDriveChange(current, operation.command, operation.createdAt),
		);
	}
	return [...collections.values()];
};
/**
 * Captures a Drive-session intent with stable identity, its current comparison base,
 * and only the prerequisites that must acknowledge first. Storage persists this
 * record before the route can report local success.
 */
export const buildDriveSyncOperation = (
	command: DriveSyncCommand,
	collections: readonly DriveSyncCollection[],
	operations: readonly DriveSyncOperation[],
	context: Readonly<{
		ownerKey: string;
		operationId: string;
		sessionId: string;
		createdAt: string;
		carDependencies: readonly string[];
	}>,
): Readonly<{
	operation: DriveSyncOperation;
	collection: DriveSyncCollection;
}> => {
	const current = collections.find(
		(collection) => collection.carId === command.carId,
	) ?? { carId: command.carId, version: 0, sessions: [] };
	const base =
		current.sessions.find((session) => session.id === command.sessionId) ??
		null;
	if (
		(command.sessionId && !base) ||
		base?.deletedAt ||
		(command.action === 'archive' && !base)
	)
		throw new Error('The Drive session is unavailable or archived.');
	const wire: DriveSyncWireCommand = {
		type: 'drive.change',
		action: command.action,
		carId: command.carId,
		sessionId: command.sessionId ?? context.sessionId,
		baseVersion: current.version,
		base,
		input: command.input,
	};
	const operation: DriveSyncOperation = {
		operationId: context.operationId,
		ownerKey: context.ownerKey,
		carId: command.carId,
		command: wire,
		createdAt: context.createdAt,
		status: 'pending',
		sequence: Math.max(0, ...operations.map((value) => value.sequence)) + 1,
		dependencies: [
			...new Set([
				...context.carDependencies,
				...operations
					.filter(
						(value) =>
							value.carId === command.carId &&
							value.command.sessionId === wire.sessionId,
					)
					.map((value) => value.operationId),
			]),
		],
	};
	return {
		operation,
		collection: applyDriveChange(current, wire, context.createdAt),
	};
};
export const readyDriveSyncOperations = (
	operations: readonly DriveSyncOperation[],
	pendingIds: ReadonlySet<string>,
): readonly DriveSyncOperation[] =>
	operations
		.filter(
			(operation) =>
				operation.status === 'pending' &&
				!operation.dependencies.some((id) => pendingIds.has(id)),
		)
		.sort((a, b) => a.sequence - b.sequence);
/**
 * Updates a queued dependent Drive-session command after an earlier acknowledgement.
 * Uses the canonical collection while preserving the pending intent and identity;
 * conflicting remote state is still checked by the server on replay.
 */
export const rebaseDriveSyncOperation = (
	operation: DriveSyncOperation,
	acknowledgedId: string,
	collection: DriveSyncCollection,
): DriveSyncOperation => {
	if (!operation.dependencies.includes(acknowledgedId)) return operation;
	return {
		...operation,
		dependencies: operation.dependencies.filter((id) => id !== acknowledgedId),
		command: {
			...operation.command,
			baseVersion: collection.version,
			base: operation.command.base
				? (collection.sessions.find(
						(session) => session.id === operation.command.base?.id,
					) ?? operation.command.base)
				: null,
		},
	};
};
export const mergeDriveCollection = (
	current: readonly DriveSyncCollection[],
	incoming: DriveSyncCollection,
): readonly DriveSyncCollection[] => {
	const existing = current.find(
		(collection) => collection.carId === incoming.carId,
	);
	if (!existing) return [...current, incoming];
	if (existing.version > incoming.version) return current;
	return current.map((collection) =>
		collection.carId === incoming.carId
			? { ...incoming, timezone: incoming.timezone ?? collection.timezone }
			: collection,
	);
};
