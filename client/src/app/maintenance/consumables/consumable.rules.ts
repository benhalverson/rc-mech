import type {
	ConsumableEntry,
	MaintenanceCar,
	MaintenanceReport,
} from '../maintenance.models';

export type TireReportAxle = {
	latest: ConsumableEntry | null;
	eventCount: number;
	averageDays: number | null;
	missingDetails: boolean;
};

export type TireReport = {
	front: TireReportAxle;
	rear: TireReportAxle;
	spend: {
		front: number | null;
		rear: number | null;
		combined: number | null;
		missingCostEntries: number;
	};
	fluidEntries: ConsumableEntry[];
};

const includesAxle = (
	entry: ConsumableEntry,
	axle: 'front' | 'rear',
): boolean => entry.axle === axle || entry.axle === 'both';

const averageIntervalDays = (entries: ConsumableEntry[]): number | null => {
	if (entries.length < 2) return null;
	let total = 0;
	for (let index = 1; index < entries.length; index += 1) {
		total +=
			(new Date(entries[index - 1].performedAt).getTime() -
				new Date(entries[index].performedAt).getTime()) /
			86400000;
	}
	return Math.round((total / (entries.length - 1)) * 10) / 10;
};

const reportAxle = (
	entries: ConsumableEntry[],
	axle: 'front' | 'rear',
): TireReportAxle => {
	const events = entries
		.filter((entry) => includesAxle(entry, axle))
		.sort((a, b) => b.performedAt.localeCompare(a.performedAt));
	return {
		latest: events[0] ?? null,
		eventCount: events.length,
		averageDays: averageIntervalDays(events),
		missingDetails: events.some((entry) =>
			axle === 'front'
				? !entry.frontDetails?.trim()
				: !entry.rearDetails?.trim(),
		),
	};
};

export const buildTireReport = (entries: ConsumableEntry[]): TireReport => {
	const tires = entries.filter(
		(entry) => entry.kind === 'tires' && !entry.deletedAt,
	);
	const fluidEntries = entries
		.filter((entry) => entry.kind !== 'tires' && !entry.deletedAt)
		.sort((a, b) => b.performedAt.localeCompare(a.performedAt));
	const missingCostEntries = tires.filter((entry) => {
		const frontMissing =
			includesAxle(entry, 'front') && entry.frontCost == null;
		const rearMissing = includesAxle(entry, 'rear') && entry.rearCost == null;
		return frontMissing || rearMissing;
	}).length;
	return {
		front: reportAxle(tires, 'front'),
		rear: reportAxle(tires, 'rear'),
		spend: {
			front: tires.reduce((total, entry) => total + (entry.frontCost ?? 0), 0),
			rear: tires.reduce((total, entry) => total + (entry.rearCost ?? 0), 0),
			combined: tires.reduce(
				(total, entry) =>
					total + (entry.frontCost ?? 0) + (entry.rearCost ?? 0),
				0,
			),
			missingCostEntries,
		},
		fluidEntries,
	};
};

export const mergeTireReport = (
	local: TireReport,
	server: MaintenanceReport | null | undefined,
): TireReport => {
	if (
		!server?.tires?.frequency?.front ||
		!server.tires.frequency.rear ||
		!server.tires.spend?.front ||
		!server.tires.spend.rear ||
		!server.tires.spend.combined
	)
		return local;
	return {
		...local,
		front: {
			...local.front,
			eventCount: server.tires.frequency.front.eventCount,
			averageDays: server.tires.frequency.front.averageIntervalDays,
		},
		rear: {
			...local.rear,
			eventCount: server.tires.frequency.rear.eventCount,
			averageDays: server.tires.frequency.rear.averageIntervalDays,
		},
		spend: {
			...local.spend,
			front: server.tires.spend.front.total,
			rear: server.tires.spend.rear.total,
			combined: server.tires.spend.combined.total,
		},
	};
};

export const spendLabel = (value: number | null): string =>
	value === null ? 'Multiple currencies' : `$${value.toFixed(2)}`;

export const visibleConsumableEntries = (
	entries: readonly ConsumableEntry[],
	filter: 'active' | 'archived',
): ConsumableEntry[] =>
	entries.filter((entry) =>
		filter === 'archived' ? Boolean(entry.deletedAt) : !entry.deletedAt,
	);

export const consumableEntryIsReadOnly = (
	entry: ConsumableEntry,
	cars: readonly MaintenanceCar[],
): boolean =>
	Boolean(cars.find((car) => car.id === entry.carId)?.archivedAt) ||
	Boolean(entry.deletedAt);

export const canCreateConsumableEntry = (
	cars: readonly MaintenanceCar[],
	action: string | null,
): boolean => !action && cars.some((car) => !car.archivedAt);

export const canEditConsumableEntry = (
	entry: ConsumableEntry,
	cars: readonly MaintenanceCar[],
	action: string | null,
): boolean => !action && !consumableEntryIsReadOnly(entry, cars);
