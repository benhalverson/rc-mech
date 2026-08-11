import type { SetupSnapshot, SetupSnapshotDraft } from './setup-snapshot';
import type {
	BuildSetupSyncOperationContext,
	BuiltSetupSyncOperation,
	SetupCorrectionBase,
	SetupCurrentSelection,
	SetupSyncCollection,
	SetupSyncCommand,
	SetupSyncDraft,
	SetupSyncMark,
	SetupSyncOperation,
} from './setup-sync.models';

const draftFields = [
	'name',
	'status',
	'setupDate',
	'track',
	'event',
	'surface',
	'traction',
	'moisture',
	'condition',
	'temperature',
	'vehicle',
	'drivetrain',
	'electronics',
	'tires',
	'shocks',
	'frontSuspension',
	'rearSuspension',
	'notes',
	'sourceUrl',
	'sourcePdfReference',
	'sourceMetadata',
	'rawValues',
	'unmappedValues',
] as const satisfies readonly (keyof SetupSyncDraft)[];

type SetupDraftField = (typeof draftFields)[number];

const compareOperations = (
	left: SetupSyncOperation,
	right: SetupSyncOperation,
): number =>
	left.sequence - right.sequence ||
	left.createdAt.localeCompare(right.createdAt) ||
	left.operationId.localeCompare(right.operationId);

const nextSequence = (operations: readonly SetupSyncOperation[]): number =>
	Math.max(0, ...operations.map((operation) => operation.sequence)) + 1;

const canonicalJson = (value: unknown): string => {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value))
		return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(',')}}`;
};

const sameValue = (left: unknown, right: unknown): boolean =>
	canonicalJson(left ?? null) === canonicalJson(right ?? null);

const sections = (draft: SetupSyncDraft): SetupSnapshot['sections'] => ({
	vehicle: (draft.vehicle as Record<string, string | null> | null) ?? {},
	drivetrain: (draft.drivetrain as Record<string, string | null> | null) ?? {},
	electronics:
		(draft.electronics as Record<string, string | null> | null) ?? {},
	tires: (draft.tires as Record<string, string | null> | null) ?? {},
	shocks: (draft.shocks as Record<string, string | null> | null) ?? {},
	frontSuspension:
		(draft.frontSuspension as Record<string, string | null> | null) ?? {},
	rearSuspension:
		(draft.rearSuspension as Record<string, string | null> | null) ?? {},
	notes: draft.notes ? { setupNotes: draft.notes } : {},
});

export const setupDraftFromSnapshot = (
	setup: SetupSnapshot,
): SetupSyncDraft => ({
	name: setup.name,
	status: setup.status ?? 'active',
	setupDate: setup.context?.recordedAt ?? null,
	track: setup.context?.track ?? null,
	event: setup.context?.event ?? null,
	surface: setup.context?.surface ?? null,
	traction: setup.context?.traction ?? null,
	moisture: setup.context?.moisture ?? null,
	condition: setup.context?.condition ?? null,
	temperature: setup.context?.temperature ?? null,
	vehicle: setup.sections.vehicle,
	drivetrain: setup.sections.drivetrain,
	electronics: setup.sections.electronics,
	tires: setup.sections.tires,
	shocks: setup.sections.shocks,
	frontSuspension: setup.sections.frontSuspension,
	rearSuspension: setup.sections.rearSuspension,
	notes: setup.sections.notes['setupNotes'] ?? null,
	sourceUrl: setup.source?.url ?? null,
	sourcePdfReference: setup.source?.pdfTitle ?? null,
	sourceMetadata: setup.source
		? {
				pdfUrl: setup.source.pdfUrl ?? null,
				pdfPage: setup.source.pdfPage ?? null,
			}
		: null,
	rawValues: setup.rawValues ?? null,
	unmappedValues: setup.unmappedValues ?? null,
});

const snapshotFromDraft = (
	draft: SetupSyncDraft,
	context: Readonly<{
		id: string;
		carId: string;
		copiedFromSetupId: string | null;
		createdAt: string;
		current: boolean;
	}>,
): SetupSnapshot => ({
	id: context.id,
	carId: context.carId,
	name: draft.name,
	status: draft.status ?? 'active',
	current: context.current,
	context: {
		recordedAt: draft.setupDate ?? null,
		track: draft.track ?? null,
		event: draft.event ?? null,
		surface: draft.surface ?? null,
		traction: draft.traction ?? null,
		moisture: draft.moisture ?? null,
		condition: draft.condition ?? null,
		temperature: draft.temperature ?? null,
	},
	sections: sections(draft),
	source: {
		url: draft.sourceUrl ?? null,
		pdfUrl:
			typeof draft.sourceMetadata?.['pdfUrl'] === 'string'
				? draft.sourceMetadata['pdfUrl']
				: null,
		pdfTitle: draft.sourcePdfReference ?? null,
		pdfPage:
			typeof draft.sourceMetadata?.['pdfPage'] === 'number'
				? draft.sourceMetadata['pdfPage']
				: null,
	},
	copiedFromSetupId: context.copiedFromSetupId,
	rawValues: draft.rawValues ?? null,
	unmappedValues: draft.unmappedValues ?? null,
	createdAt: context.createdAt,
	updatedAt: context.createdAt,
	version: 0,
});

const correctedSnapshot = (
	setup: SetupSnapshot,
	changes: SetupSyncDraft,
	updatedAt: string,
): SetupSnapshot => ({
	...snapshotFromDraft(
		{ ...setupDraftFromSnapshot(setup), ...changes },
		{
			id: setup.id,
			carId: setup.carId,
			copiedFromSetupId: setup.copiedFromSetupId ?? null,
			createdAt: setup.createdAt ?? updatedAt,
			current: setup.current === true,
		},
	),
	version: setup.version,
});

const normalizeCurrent = (
	collection: SetupSyncCollection,
	currentSetupId = collection.currentSetupId,
	currentSetupVersion = collection.currentSetupVersion,
): SetupSyncCollection => ({
	...collection,
	currentSetupId,
	currentSetupVersion,
	setups: collection.setups.map((setup) => ({
		...setup,
		current: setup.id === currentSetupId,
	})),
});

const replaceSetup = (
	setups: readonly SetupSnapshot[],
	updated: SetupSnapshot,
): readonly SetupSnapshot[] =>
	setups.some((setup) => setup.id === updated.id)
		? setups.map((setup) => (setup.id === updated.id ? updated : setup))
		: [updated, ...setups];

const applyOperation = (
	collection: SetupSyncCollection,
	operation: SetupSyncOperation,
): SetupSyncCollection => {
	const command = operation.command;
	if (command.type === 'setup.select-current')
		return normalizeCurrent(collection, command.setupId);
	if (command.type === 'setup.correct') {
		const current = collection.setups.find(
			(setup) => setup.id === command.setupId,
		);
		if (!current) return collection;
		return normalizeCurrent({
			...collection,
			setups: replaceSetup(
				collection.setups,
				correctedSnapshot(current, command.changes, operation.createdAt),
			),
		});
	}
	const created = snapshotFromDraft(command.setup, {
		id: command.setupId,
		carId: command.carId,
		copiedFromSetupId: command.copiedFromSetupId,
		createdAt: operation.createdAt,
		current: command.makeCurrent,
	});
	return normalizeCurrent(
		{ ...collection, setups: replaceSetup(collection.setups, created) },
		command.makeCurrent ? created.id : collection.currentSetupId,
	);
};

export const materializeSetupCollections = (
	canonicalCollections: readonly SetupSyncCollection[],
	operations: readonly SetupSyncOperation[],
): readonly SetupSyncCollection[] => {
	const collections = new Map(
		canonicalCollections.map((collection) => [
			collection.carId,
			normalizeCurrent(collection),
		]),
	);
	for (const operation of [...operations].sort(compareOperations)) {
		const current =
			collections.get(operation.carId) ??
			({
				carId: operation.carId,
				currentSetupId: null,
				currentSetupVersion: 0,
				setups: [],
			} satisfies SetupSyncCollection);
		collections.set(operation.carId, applyOperation(current, operation));
	}
	return [...collections.values()];
};

const operationDependencies = (
	carId: string,
	operations: readonly SetupSyncOperation[],
	carDependencies: readonly string[],
): readonly string[] => {
	const previous = operations
		.filter((operation) => operation.carId === carId)
		.sort(compareOperations)
		.at(-1);
	return [...carDependencies, ...(previous ? [previous.operationId] : [])];
};

const currentSelection = (
	collection: SetupSyncCollection,
): SetupCurrentSelection => ({
	setupId: collection.currentSetupId,
	version: collection.currentSetupVersion,
});

const correction = (
	setup: SetupSnapshot,
	draft: SetupSnapshotDraft,
): Readonly<{ base: SetupCorrectionBase; changes: SetupSyncDraft }> => {
	const previous = setupDraftFromSnapshot(setup);
	const candidate = { ...draft } as SetupSyncDraft;
	const base: Record<string, unknown> = {};
	const changes: Partial<SetupSyncDraft> = {};
	for (const field of draftFields) {
		if (!(field in candidate) || sameValue(previous[field], candidate[field]))
			continue;
		base[field] = previous[field] ?? null;
		Object.assign(changes, { [field]: candidate[field] });
	}
	if (Object.keys(changes).length === 0)
		throw new Error('At least one setup correction is required');
	return { base, changes: changes as SetupSyncDraft };
};

export const buildSetupSyncOperation = (
	command: SetupSyncCommand,
	collections: readonly SetupSyncCollection[],
	operations: readonly SetupSyncOperation[],
	context: BuildSetupSyncOperationContext,
): BuiltSetupSyncOperation => {
	const collection =
		collections.find((candidate) => candidate.carId === command.carId) ??
		({
			carId: command.carId,
			currentSetupId: null,
			currentSetupVersion: 0,
			setups: [],
		} satisfies SetupSyncCollection);
	const existing =
		command.type === 'create'
			? undefined
			: collection.setups.find((setup) => setup.id === command.setupId);
	if (command.type !== 'create' && !existing)
		throw new Error('Setup not found');
	const createsSnapshot =
		command.type === 'create' ||
		command.type === 'copy' ||
		command.type === 'change';
	const setupId = createsSnapshot ? context.setupId : command.setupId;
	if (!setupId) throw new Error('A stable Setup identity is required');
	let wire: SetupSyncOperation['command'];
	if (command.type === 'select-current') {
		wire = {
			type: 'setup.select-current',
			carId: command.carId,
			setupId,
			baseCurrent: currentSelection(collection),
		};
	} else if (command.type === 'correct') {
		const update = correction(existing as SetupSnapshot, command.draft);
		wire = {
			type: 'setup.correct',
			carId: command.carId,
			setupId,
			baseVersion: existing?.version ?? 0,
			...update,
		};
	} else {
		const copiedFromSetupId =
			command.type === 'copy' || command.type === 'change'
				? command.setupId
				: null;
		const draft =
			command.type === 'copy'
				? setupDraftFromSnapshot(existing as SetupSnapshot)
				: ({ ...command.draft, makeCurrent: undefined } as SetupSyncDraft);
		const makeCurrent =
			command.type === 'change' ||
			(command.type !== 'copy' && command.draft.makeCurrent === true);
		wire = {
			type: 'setup.create',
			carId: command.carId,
			setupId,
			copiedFromSetupId,
			setup: draft,
			makeCurrent,
			baseCurrent: makeCurrent ? currentSelection(collection) : null,
		};
	}
	const operation: SetupSyncOperation = {
		operationId: context.operationId,
		ownerKey: context.ownerKey,
		carId: command.carId,
		setupId,
		command: wire,
		dependencies: operationDependencies(
			command.carId,
			operations,
			context.carDependencies ?? [],
		),
		status: 'pending',
		createdAt: context.createdAt,
		sequence: nextSequence(operations),
	};
	const materialized = applyOperation(collection, operation);
	return {
		operation,
		collection: materialized,
		setup: materialized.setups.find(
			(setup) => setup.id === setupId,
		) as SetupSnapshot,
	};
};

export const readySetupSyncOperations = (
	operations: readonly SetupSyncOperation[],
	blockingOperationIds: ReadonlySet<string>,
): readonly SetupSyncOperation[] =>
	operations
		.filter(
			(operation) =>
				operation.status === 'pending' &&
				operation.dependencies.every(
					(dependency) => !blockingOperationIds.has(dependency),
				),
		)
		.sort(compareOperations);

export const rebaseSetupSyncOperation = (
	operation: SetupSyncOperation,
	completedOperationId: string,
	acknowledged: SetupSyncCollection,
): SetupSyncOperation => {
	if (!operation.dependencies.includes(completedOperationId)) return operation;
	const dependencies = operation.dependencies.filter(
		(dependency) => dependency !== completedOperationId,
	);
	if (operation.command.type === 'setup.select-current')
		return {
			...operation,
			dependencies,
			command: {
				...operation.command,
				baseCurrent: currentSelection(acknowledged),
			},
		};
	if (operation.command.type === 'setup.create')
		return {
			...operation,
			dependencies,
			command: {
				...operation.command,
				baseCurrent: operation.command.makeCurrent
					? currentSelection(acknowledged)
					: null,
			},
		};
	const setup = acknowledged.setups.find(
		(candidate) => candidate.id === operation.setupId,
	);
	if (!setup) return { ...operation, dependencies };
	const previous = setupDraftFromSnapshot(setup);
	const base = Object.fromEntries(
		Object.keys(operation.command.base).map((field) => [
			field,
			previous[field as SetupDraftField] ?? null,
		]),
	);
	return {
		...operation,
		dependencies,
		command: {
			...operation.command,
			baseVersion: setup.version ?? 0,
			base,
		},
	};
};

export const setupSyncMark = (
	operations: readonly SetupSyncOperation[],
	syncingOperationIds: ReadonlySet<string>,
): SetupSyncMark => {
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
