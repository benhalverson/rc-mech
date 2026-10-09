import type { InstalledComponent } from '../car.models';
import type {
	BuildSyncCollection,
	BuildSyncCommand,
	BuildSyncOperation,
	BuildSyncWireCommand,
} from './build-sync.models';

export const applyBuildChange = (
	collection: BuildSyncCollection,
	command: BuildSyncWireCommand,
	createdAt: string,
): BuildSyncCollection => {
	const oldId = command.base?.id;
	const input = command.input;
	const edited = {
		...input,
		manufacturer: input.manufacturer ?? null,
		model: input.model ?? null,
		serialNumber: input.serialNumber ?? null,
		notes: input.notes ?? null,
	};
	const replaced = collection.components.map((component) => {
		if (component.id !== oldId) return component;
		return command.action === 'edit'
			? { ...component, ...edited }
			: { ...component, removedAt: createdAt };
	});
	const components =
		command.action === 'install' || command.action === 'replace'
			? [
					...replaced,
					{
						...edited,
						id: command.componentId,
						carId: command.carId,
						installedAt: command.input.installedAt ?? createdAt,
						removedAt: null,
					},
				]
			: replaced;
	return { ...collection, version: collection.version + 1, components };
};

export const materializeBuildCollections = (
	canonical: readonly BuildSyncCollection[],
	operations: readonly BuildSyncOperation[],
): readonly BuildSyncCollection[] => {
	const collections = new Map(
		canonical.map((collection) => [collection.carId, collection]),
	);
	for (const operation of [...operations].sort(
		(a, b) => a.sequence - b.sequence,
	)) {
		const current = collections.get(operation.carId) ?? {
			carId: operation.carId,
			version: 0,
			components: [],
		};
		collections.set(
			operation.carId,
			applyBuildChange(current, operation.command, operation.createdAt),
		);
	}
	return [...collections.values()];
};

export const buildBuildSyncOperation = (
	command: BuildSyncCommand,
	collections: readonly BuildSyncCollection[],
	operations: readonly BuildSyncOperation[],
	context: Readonly<{
		ownerKey: string;
		operationId: string;
		componentId: string;
		createdAt: string;
		carDependencies: readonly string[];
	}>,
): Readonly<{
	operation: BuildSyncOperation;
	collection: BuildSyncCollection;
}> => {
	const current = collections.find(
		(collection) => collection.carId === command.carId,
	) ?? { carId: command.carId, version: 0, components: [] };
	const base: InstalledComponent | null =
		current.components.find(
			(component) =>
				!component.removedAt &&
				(command.action === 'install'
					? component.slot === command.input.slot
					: component.id === command.componentId),
		) ?? null;
	if (command.action !== 'install' && !base)
		throw new Error('The current Component is unavailable.');
	const slot = command.input.slot ?? base?.slot;
	if (!slot) throw new Error('A Component slot is required.');
	const normalizedBase = base
		? {
				...base,
				slotType: base.slotType ?? 'custom',
				manufacturer: base.manufacturer ?? null,
				model: base.model ?? null,
				serialNumber: base.serialNumber ?? null,
				notes: base.notes ?? null,
				installedAt: base.installedAt ?? context.createdAt,
				removedAt: null,
			}
		: null;
	const existingId = base?.id ?? context.componentId;
	const wire: BuildSyncWireCommand = {
		type: 'build.change',
		action: command.action,
		carId: command.carId,
		componentId:
			command.action === 'install' || command.action === 'replace'
				? context.componentId
				: existingId,
		baseVersion: current.version,
		base: normalizedBase,
		input: {
			...command.input,
			slot,
			slotType: command.input.slotType ?? base?.slotType ?? 'custom',
		},
	};
	const operation: BuildSyncOperation = {
		operationId: context.operationId,
		ownerKey: context.ownerKey,
		carId: command.carId,
		command: wire,
		createdAt: context.createdAt,
		status: 'pending',
		sequence:
			Math.max(0, ...operations.map((operation) => operation.sequence)) + 1,
		dependencies: [
			...new Set([
				...context.carDependencies,
				...operations
					.filter(
						(operation) =>
							operation.carId === command.carId &&
							operation.command.input.slot === slot,
					)
					.map((operation) => operation.operationId),
			]),
		],
	};
	return {
		operation,
		collection: applyBuildChange(current, wire, context.createdAt),
	};
};

export const readyBuildSyncOperations = (
	operations: readonly BuildSyncOperation[],
	pendingIds: ReadonlySet<string>,
): readonly BuildSyncOperation[] =>
	operations
		.filter(
			(operation) =>
				operation.status === 'pending' &&
				!operation.dependencies.some((id) => pendingIds.has(id)),
		)
		.sort((a, b) => a.sequence - b.sequence);

export const rebaseBuildSyncOperation = (
	operation: BuildSyncOperation,
	acknowledgedId: string,
	collection: BuildSyncCollection,
): BuildSyncOperation => {
	if (!operation.dependencies.includes(acknowledgedId)) return operation;
	return {
		...operation,
		dependencies: operation.dependencies.filter((id) => id !== acknowledgedId),
		command: {
			...operation.command,
			baseVersion: collection.version,
			base: operation.command.base
				? (collection.components.find(
						(component) => component.id === operation.command.base?.id,
					) ?? operation.command.base)
				: null,
		},
	};
};

export const mergeBuildCollection = (
	current: readonly BuildSyncCollection[],
	incoming: BuildSyncCollection,
): readonly BuildSyncCollection[] => {
	const existing = current.find(
		(collection) => collection.carId === incoming.carId,
	);
	if (!existing) return [...current, incoming];
	if (existing.version > incoming.version) return current;
	return current.map((collection) =>
		collection.carId === incoming.carId ? incoming : collection,
	);
};
