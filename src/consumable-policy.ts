export type ConsumableLifecycle = { archivedAt: string | null };

export const canEditConsumable = (value: ConsumableLifecycle): boolean =>
	value.archivedAt === null;
export const canArchiveConsumable = (value: ConsumableLifecycle): boolean =>
	value.archivedAt === null;
export const canRestoreConsumable = (value: ConsumableLifecycle): boolean =>
	value.archivedAt !== null;
export const ownsConsumable = (
	entryCarId: string | null | undefined,
	authorizedCarId: string,
): boolean => Boolean(entryCarId) && entryCarId === authorizedCarId;

type SetupTireValues = Record<string, unknown>;
const objectValue = (value: unknown): SetupTireValues | undefined =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as SetupTireValues)
		: undefined;

export const mapSetupTiresToAxles = (value: unknown) => {
	const tires = objectValue(value);
	if (!tires) return { front: null, rear: null };
	const front = objectValue(tires.front ?? tires.frontTires);
	const rear = objectValue(tires.rear ?? tires.rearTires);
	return { front: front ?? tires, rear: rear ?? tires };
};

export type ConsumableReportEntry = {
	id?: string | null;
	kind: string;
	performedAt: string;
	fluidArea?: string | null;
	customFluidArea?: string | null;
	front?: unknown;
	rear?: unknown;
	frontDetails?: unknown;
	rearDetails?: unknown;
	frontCost?: number | null;
	frontCurrency?: string | null;
	rearCost?: number | null;
	rearCurrency?: string | null;
	archivedAt?: string | null;
};

type Axle = 'front' | 'rear';
type AxleEvent = { id: string | null; changedAt: string };

const present = (value: unknown): boolean => {
	if (value === null || value === undefined) return false;
	if (typeof value === 'string') return value.length > 0;
	return true;
};

const parsedDetails = (value: unknown): unknown => {
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
};

const hasAxle = (entry: ConsumableReportEntry, axle: Axle): boolean =>
	present(
		axle === 'front'
			? (entry.front ?? parsedDetails(entry.frontDetails))
			: (entry.rear ?? parsedDetails(entry.rearDetails)),
	);

const eventsFor = (entries: ConsumableReportEntry[], axle: Axle): AxleEvent[] =>
	entries
		.filter((entry) => entry.kind === 'tires' && hasAxle(entry, axle))
		.sort((left, right) => right.performedAt.localeCompare(left.performedAt))
		.map((entry) => ({ id: entry.id ?? null, changedAt: entry.performedAt }));

const frequencyFor = (events: AxleEvent[]) => {
	const intervals = events
		.slice(1)
		.map((event, index) =>
			Math.max(
				0,
				(new Date(events[index].changedAt).getTime() -
					new Date(event.changedAt).getTime()) /
					(24 * 60 * 60 * 1000),
			),
		);
	return {
		status:
			events.length < 2
				? ('insufficient-history' as const)
				: ('calculated' as const),
		eventCount: events.length,
		averageIntervalDays:
			events.length < 2
				? null
				: Math.round(
						(intervals.reduce((sum, value) => sum + value, 0) /
							intervals.length) *
							100,
					) / 100,
		intervalDays: intervals,
	};
};

const spendFor = (entries: ConsumableReportEntry[], axle: Axle) => {
	const costKey = axle === 'front' ? 'frontCost' : 'rearCost';
	const currencyKey = axle === 'front' ? 'frontCurrency' : 'rearCurrency';
	const recorded = entries
		.filter((entry) => entry.kind === 'tires' && hasAxle(entry, axle))
		.map((entry) => {
			const axleValue = entry[axle];
			const nested =
				axleValue && typeof axleValue === 'object'
					? (axleValue as { cost?: unknown; currency?: unknown })
					: undefined;
			return {
				cost: entry[costKey] ?? nested?.cost ?? null,
				currency: entry[currencyKey] ?? nested?.currency ?? null,
			};
		})
		.filter(
			(value): value is { cost: number; currency: string } =>
				typeof value.cost === 'number' && typeof value.currency === 'string',
		);
	const currencies = [...new Set(recorded.map((value) => value.currency))];
	return {
		total:
			currencies.length <= 1
				? recorded.reduce((sum, value) => sum + value.cost, 0)
				: null,
		currency: currencies.length === 1 ? currencies[0] : null,
		byCurrency: currencies.map((currency) => ({
			currency,
			total: recorded
				.filter((value) => value.currency === currency)
				.reduce((sum, value) => sum + value.cost, 0),
		})),
		recordedCount: recorded.length,
		eventCount: entries.filter(
			(entry) => entry.kind === 'tires' && hasAxle(entry, axle),
		).length,
		isIncomplete:
			recorded.length <
			entries.filter((entry) => entry.kind === 'tires' && hasAxle(entry, axle))
				.length,
	};
};

export const calculateConsumableReport = (input: ConsumableReportEntry[]) => {
	const entries = input.filter((entry) => entry.archivedAt == null);
	const frontEvents = eventsFor(entries, 'front');
	const rearEvents = eventsFor(entries, 'rear');
	const frontSpend = spendFor(entries, 'front');
	const rearSpend = spendFor(entries, 'rear');
	const combinedByCurrency = [
		...frontSpend.byCurrency,
		...rearSpend.byCurrency,
	].reduce<{ currency: string; total: number }[]>((result, value) => {
		const existing = result.find((item) => item.currency === value.currency);
		if (existing) existing.total += value.total;
		else result.push({ ...value });
		return result;
	}, []);
	const fluids = entries
		.filter((entry) => entry.kind === 'fluid')
		.sort((left, right) => right.performedAt.localeCompare(left.performedAt))
		.map((entry) => ({
			id: entry.id ?? null,
			area: entry.fluidArea ?? 'custom',
			customArea: entry.customFluidArea ?? null,
			lastChangedAt: entry.performedAt,
		}));
	return {
		tires: {
			latestFront: frontEvents[0] ?? null,
			latestRear: rearEvents[0] ?? null,
			frequency: {
				front: frequencyFor(frontEvents),
				rear: frequencyFor(rearEvents),
			},
			spend: {
				front: frontSpend,
				rear: rearSpend,
				combined: {
					total:
						combinedByCurrency.length === 0
							? 0
							: combinedByCurrency.length === 1
								? combinedByCurrency[0].total
								: null,
					currency:
						combinedByCurrency.length === 1
							? combinedByCurrency[0].currency
							: null,
					byCurrency: combinedByCurrency,
					isIncomplete: frontSpend.isIncomplete || rearSpend.isIncomplete,
				},
			},
		},
		fluidHistory: fluids,
	};
};
