import { and, eq, isNull, or } from 'drizzle-orm';
import { ownsCar } from '../car-policy';
import { componentSlotType, normalizeComponentSlot } from '../component-policy';
import { db } from '../db';
import { presentDateTime } from '../drive-session-policy';
import {
	calculateMaintenanceDue,
	type MaintenanceIntervalUnit,
	type MaintenanceStatus,
} from '../maintenance-policy';
import { validatePhotoMetadata } from '../photo-policy';
import {
	car,
	component,
	consumableMaintenanceEntry,
	driveSession,
	maintenancePlan,
	owner,
	photo,
	setup,
	setupImportDraft,
} from '../schema';
import {
	canonicalSetupImportUrl,
	type SetupImportExtraction,
	type SetupImportSource,
} from '../setup-import-policy';
import { ownsSetup } from '../setup-policy';
import { AppContext, type ConsumableInput, type SetupInput } from '../types';

export const required = <T>(
	value: T | null | undefined,
	message: string,
): T => {
	if (value == null) throw new Error(message);
	return value;
};

export const ownedCar = async (c: AppContext, carId: string) => {
	const value = await db(c.env)
		.select()
		.from(car)
		.where(and(eq(car.id, carId), eq(car.ownerId, c.get('userId'))))
		.get();
	return value && ownsCar(value.ownerId, c.get('userId')) ? value : undefined;
};

export const publicCar = (value: typeof car.$inferSelect) => {
	const { ownerId: _ownerId, ...result } = value;
	return result;
};

export const jsonText = (value: unknown): string | null | undefined =>
	value === undefined
		? undefined
		: value === null
			? null
			: JSON.stringify(value);

export const jsonValue = (value: string | null): unknown => {
	if (value === null) return null;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
};

export const readLimitedText = async (
	response: Response,
	limit = 1_000_000,
) => {
	if (!response.body) return '';
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			size += next.value.byteLength;
			if (size > limit) throw new Error('Source page is too large');
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
};

export const fetchSoDialedSource = async (
	url: URL,
): Promise<SetupImportSource> => {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 8_000);
	try {
		const response = await fetch(url, {
			redirect: 'manual',
			headers: { accept: 'text/html' },
			signal: controller.signal,
		});
		if (!response.ok || response.headers.has('location'))
			throw new Error('So Dialed setup page is unavailable');
		const canonicalUrl = canonicalSetupImportUrl(response.url);
		if (!canonicalUrl)
			throw new Error('So Dialed source redirected unexpectedly');
		return { canonicalUrl, html: await readLimitedText(response) };
	} finally {
		clearTimeout(timeout);
	}
};

export const publicImportDraft = (
	value: typeof setupImportDraft.$inferSelect,
) => ({
	id: value.id,
	carId: value.carId,
	sourceUrl: value.sourceUrl,
	status: value.status,
	sourceIdentity: jsonValue(value.sourceIdentity),
	source: {
		url: value.sourceUrl,
		hasPdfReference: value.sourcePdfReference !== null,
		metadata: jsonValue(value.sourceMetadata),
	},
	knownValues: jsonValue(value.knownValues) ?? {},
	uncertainValues: jsonValue(value.uncertainValues) ?? {},
	rawValues: jsonValue(value.rawValues) ?? {},
	unmappedValues: jsonValue(value.unmappedValues) ?? {},
	error: value.error,
	acceptedSetupId: value.acceptedSetupId,
	createdAt: value.createdAt,
	updatedAt: value.updatedAt,
});

export const draftValues = (value: SetupImportExtraction) => ({
	sourceIdentity: jsonText(value.sourceIdentity) ?? null,
	sourcePdfReference: value.sourcePdfReference ?? null,
	sourceMetadata: jsonText(value.sourceMetadata) ?? null,
	knownValues: JSON.stringify(value.knownValues),
	uncertainValues: JSON.stringify(value.uncertainValues),
	rawValues: JSON.stringify(value.rawValues),
	unmappedValues: JSON.stringify(value.unmappedValues),
});

export const publicSetup = (
	value: typeof setup.$inferSelect,
	current = false,
) => {
	const sourceMetadata = jsonValue(value.sourceMetadata);
	const sourceObject =
		sourceMetadata && typeof sourceMetadata === 'object'
			? (sourceMetadata as { pdfUrl?: string; pdfPage?: number })
			: null;
	return {
		id: value.id,
		carId: value.carId,
		name: value.name,
		status: value.status,
		current,
		context: {
			recordedAt: value.setupDate,
			track: value.track,
			event: value.event,
			surface: value.surface,
			traction: value.traction,
			moisture: value.moisture,
			condition: value.condition,
			temperature: value.temperature,
		},
		sections: {
			vehicle: jsonValue(value.vehicle) ?? {},
			drivetrain: jsonValue(value.drivetrain) ?? {},
			electronics: jsonValue(value.electronics) ?? {},
			tires: jsonValue(value.tires) ?? {},
			shocks: jsonValue(value.shocks) ?? {},
			frontSuspension: jsonValue(value.frontSuspension) ?? {},
			rearSuspension: jsonValue(value.rearSuspension) ?? {},
			notes: value.notes ? { setupNotes: value.notes } : {},
		},
		tires: jsonValue(value.tires),
		notes: value.notes,
		source: {
			url: value.sourceUrl,
			pdfUrl: sourceObject?.pdfUrl ?? null,
			pdfTitle: value.sourcePdfReference,
			pdfPage: sourceObject?.pdfPage ?? null,
			metadata: sourceMetadata,
		},
		copiedFromSetupId: value.copiedFromId,
		rawValues: jsonValue(value.rawValues),
		unmappedValues: jsonValue(value.unmappedValues),
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
};

export const setupInsertValues = (
	id: string,
	carId: string,
	value: SetupInput,
	now: string,
	copiedFromId: string | null = null,
) => ({
	id,
	carId,
	name: value.name,
	status: value.status ?? 'active',
	setupDate: value.setupDate ? new Date(value.setupDate).toISOString() : null,
	track: value.track ?? null,
	event: value.event ?? null,
	surface: value.surface ?? null,
	traction: value.traction ?? null,
	moisture: value.moisture ?? null,
	condition: value.condition ?? null,
	temperature: value.temperature ?? null,
	vehicle: jsonText(value.vehicle) ?? null,
	drivetrain: jsonText(value.drivetrain) ?? null,
	electronics: jsonText(value.electronics) ?? null,
	tires: jsonText(value.tires) ?? null,
	shocks: jsonText(value.shocks) ?? null,
	frontSuspension: jsonText(value.frontSuspension) ?? null,
	rearSuspension: jsonText(value.rearSuspension) ?? null,
	notes: value.notes ?? null,
	sourceUrl: value.sourceUrl ?? null,
	sourcePdfReference: value.sourcePdfReference ?? null,
	sourceMetadata: jsonText(value.sourceMetadata) ?? null,
	copiedFromId,
	rawValues: jsonText(value.rawValues) ?? null,
	unmappedValues: jsonText(value.unmappedValues) ?? null,
	createdAt: now,
	updatedAt: now,
});

export const setupCopyValue = (
	value: typeof setup.$inferSelect,
): SetupInput => ({
	name: value.name,
	status: value.status as SetupInput['status'],
	setupDate: value.setupDate ?? undefined,
	track: value.track ?? undefined,
	event: value.event ?? undefined,
	surface: value.surface ?? undefined,
	traction: value.traction ?? undefined,
	moisture: value.moisture ?? undefined,
	condition: value.condition ?? undefined,
	temperature: value.temperature ?? undefined,
	vehicle:
		(jsonValue(value.vehicle) as Record<string, unknown> | null) ?? undefined,
	drivetrain:
		(jsonValue(value.drivetrain) as Record<string, unknown> | null) ??
		undefined,
	electronics:
		(jsonValue(value.electronics) as Record<string, unknown> | null) ??
		undefined,
	tires:
		(jsonValue(value.tires) as Record<string, unknown> | null) ?? undefined,
	shocks:
		(jsonValue(value.shocks) as Record<string, unknown> | null) ?? undefined,
	frontSuspension:
		(jsonValue(value.frontSuspension) as Record<string, unknown> | null) ??
		undefined,
	rearSuspension:
		(jsonValue(value.rearSuspension) as Record<string, unknown> | null) ??
		undefined,
	notes: value.notes ?? undefined,
	sourceUrl: value.sourceUrl ?? undefined,
	sourcePdfReference: value.sourcePdfReference ?? undefined,
	sourceMetadata:
		(jsonValue(value.sourceMetadata) as Record<string, unknown> | null) ??
		undefined,
	rawValues:
		(jsonValue(value.rawValues) as Record<string, unknown> | null) ?? undefined,
	unmappedValues:
		(jsonValue(value.unmappedValues) as Record<string, unknown> | null) ??
		undefined,
});

export const ownedSetup = async (
	c: AppContext,
	carId: string,
	setupId: string,
) => {
	const value = await db(c.env)
		.select()
		.from(setup)
		.where(and(eq(setup.id, setupId), eq(setup.carId, carId)))
		.get();
	return value && ownsSetup(value, carId) && (await ownedCar(c, carId))
		? value
		: undefined;
};

export const publicComponent = (value: typeof component.$inferSelect) => value;

export const ownerTimezone = async (c: AppContext): Promise<string> =>
	(
		await db(c.env)
			.select({ timezone: owner.timezone })
			.from(owner)
			.where(eq(owner.id, c.get('userId')))
			.get()
	)?.timezone ?? 'UTC';

export const publicDriveSession = (
	value: typeof driveSession.$inferSelect,
	timezone: string,
) => ({
	...value,
	...presentDateTime(value.startedAt, timezone),
});

export const driveSessionCount = async (c: AppContext, carId: string) => {
	const rows = await db(c.env)
		.select({ id: driveSession.id })
		.from(driveSession)
		.where(and(eq(driveSession.carId, carId), isNull(driveSession.deletedAt)));
	return rows.length;
};

export const planSessionCount = driveSessionCount;

export const planDue = (
	value: typeof maintenancePlan.$inferSelect,
	currentSessionCount: number,
	timezone: string,
	now = new Date().toISOString(),
) => {
	const intervalUnit = (value.intervalUnit ||
		(value.intervalDays ? 'days' : 'none')) as MaintenanceIntervalUnit;
	const intervalValue = value.intervalValue || value.intervalDays || 1;
	return {
		...value,
		intervalUnit,
		intervalValue: intervalUnit === 'none' ? null : intervalValue,
		currentSessionCount,
		timezone,
		...calculateMaintenanceDue({
			status: value.status as MaintenanceStatus,
			baselineAt: value.baselineAt,
			baselineSessionCount: value.baselineSessionCount,
			intervalUnit,
			intervalValue,
			intervalSessions: value.intervalSessions,
			currentSessionCount,
			now,
			timezone,
		}),
	};
};

export const sessionCountsForCars = async (c: AppContext, carIds: string[]) => {
	if (!carIds.length) return new Map<string, number>();
	const rows = await db(c.env)
		.select({ carId: driveSession.carId })
		.from(driveSession)
		.where(
			and(
				isNull(driveSession.deletedAt),
				or(...carIds.map((carId) => eq(driveSession.carId, carId))),
			),
		);
	const counts = new Map<string, number>();
	for (const row of rows)
		counts.set(row.carId, (counts.get(row.carId) ?? 0) + 1);
	return counts;
};

export const carPlan = async (c: AppContext, planId: string) => {
	const value = await db(c.env)
		.select()
		.from(maintenancePlan)
		.where(eq(maintenancePlan.id, planId))
		.get();
	return value && (await ownedCar(c, value.carId)) ? value : undefined;
};

export const ownedComponent = async (
	c: AppContext,
	carId: string,
	componentId: string,
) =>
	db(c.env)
		.select()
		.from(component)
		.where(and(eq(component.id, componentId), eq(component.carId, carId)))
		.get();

export const ownedPhoto = async (c: AppContext, photoId: string) => {
	const value = await db(c.env)
		.select()
		.from(photo)
		.where(eq(photo.id, photoId))
		.get();
	return value && (await ownedCar(c, value.carId)) ? value : undefined;
};

export const publicConsumable = (
	value: typeof consumableMaintenanceEntry.$inferSelect,
) => {
	const front = value.frontDetails ? jsonValue(value.frontDetails) : null;
	const rear = value.rearDetails ? jsonValue(value.rearDetails) : null;
	const details = (item: unknown) =>
		item && typeof item === 'object' && 'details' in item
			? (item as { details?: unknown }).details
			: item;
	return {
		id: value.id,
		carId: value.carId,
		kind:
			value.kind === 'fluid'
				? (
						value.fluidArea === 'custom'
							? value.customFluidArea?.toLowerCase().includes('shock')
							: value.fluidArea?.includes('shocks')
					)
					? 'shock-fluid'
					: 'differential-fluid'
				: value.kind,
		performedAt: value.performedAt,
		fluidArea: value.fluidArea,
		customFluidArea: value.customFluidArea,
		customArea: value.customFluidArea,
		front,
		rear,
		axle:
			value.kind === 'tires'
				? front && rear
					? 'both'
					: front
						? 'front'
						: 'rear'
				: null,
		frontDetails: details(front),
		rearDetails: details(rear),
		frontCost: value.frontCost,
		rearCost: value.rearCost,
		cost: value.cost,
		currency: value.currency,
		notes: value.notes,
		prefilledFromSetupId: value.prefilledFromSetupId,
		archivedAt: value.archivedAt,
		deletedAt: value.archivedAt,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
};

export const ownedConsumable = async (c: AppContext, entryId: string) => {
	const value = await db(c.env)
		.select()
		.from(consumableMaintenanceEntry)
		.where(eq(consumableMaintenanceEntry.id, entryId))
		.get();
	return value && (await ownedCar(c, value.carId)) ? value : undefined;
};

export const consumableInsertValues = (
	id: string,
	carId: string,
	value: ConsumableInput,
	now: string,
	prefilledFromSetupId: string | null,
) => ({
	id,
	carId,
	kind: value.kind,
	performedAt: new Date(value.performedAt).toISOString(),
	fluidArea: value.kind === 'fluid' ? value.fluidArea : null,
	customFluidArea:
		value.kind === 'fluid' ? (value.customFluidArea ?? null) : null,
	frontDetails:
		value.kind === 'tires' && value.front ? JSON.stringify(value.front) : null,
	frontCost: value.kind === 'tires' ? (value.front?.cost ?? null) : null,
	frontCurrency:
		value.kind === 'tires' ? (value.front?.currency ?? null) : null,
	rearDetails:
		value.kind === 'tires' && value.rear ? JSON.stringify(value.rear) : null,
	rearCost: value.kind === 'tires' ? (value.rear?.cost ?? null) : null,
	rearCurrency: value.kind === 'tires' ? (value.rear?.currency ?? null) : null,
	cost: value.kind === 'fluid' ? (value.cost ?? null) : null,
	currency: value.kind === 'fluid' ? (value.currency ?? null) : null,
	notes: value.notes ?? null,
	prefilledFromSetupId,
	archivedAt: null,
	createdAt: now,
	updatedAt: now,
});

export const publicPhoto = (value: typeof photo.$inferSelect) => ({
	id: value.id,
	carId: value.carId,
	fileName: value.fileName,
	contentType: value.contentType,
	byteSize: value.byteSize,
	sortOrder: value.sortOrder,
	isPrimary: value.isPrimary,
	createdAt: value.createdAt,
	url: `/api/v1/photos/${value.id}`,
});

export const parsePhotoForm = async (c: AppContext) => {
	const body = await c.req.parseBody();
	const file = body.file;
	if (!(file instanceof File))
		return { error: 'A photo file is required' as const };
	const fileName = file.name.trim();
	const contentType = file.type.toLowerCase();
	const error = validatePhotoMetadata({
		contentType,
		fileName,
		byteSize: file.size,
	});
	if (error) return { error };
	return {
		file,
		fileName,
		contentType,
		sortOrder: body.sortOrder,
		primary: body.primary,
	};
};

export const parseComponentSlot = (
	slot: string,
	requested?: 'standard' | 'custom',
) => {
	const slotType = componentSlotType(slot, requested);
	return slotType === 'invalid'
		? undefined
		: {
				slot:
					slotType === 'standard' ? normalizeComponentSlot(slot) : slot.trim(),
				slotType,
			};
};
