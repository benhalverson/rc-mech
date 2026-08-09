import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { setup } from '../../schema';
import { ownsSetup } from '../../setup-policy';
import type { AppContext, SetupInput } from '../../types';
import { ownedCar } from '../cars/car-records';
import { jsonText, jsonValue } from '../json-values';

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

const setupInsertParameter = <T>(value: T, column: { readonly name: string }) =>
	sql<T>`${value}`.as(column.name);

export const setupInsertSelection = (
	value: ReturnType<typeof setupInsertValues>,
) => ({
	id: setupInsertParameter(value.id, setup.id),
	carId: setupInsertParameter(value.carId, setup.carId),
	name: setupInsertParameter(value.name, setup.name),
	status: setupInsertParameter(value.status, setup.status),
	setupDate: setupInsertParameter(value.setupDate, setup.setupDate),
	track: setupInsertParameter(value.track, setup.track),
	event: setupInsertParameter(value.event, setup.event),
	surface: setupInsertParameter(value.surface, setup.surface),
	traction: setupInsertParameter(value.traction, setup.traction),
	moisture: setupInsertParameter(value.moisture, setup.moisture),
	condition: setupInsertParameter(value.condition, setup.condition),
	temperature: setupInsertParameter(value.temperature, setup.temperature),
	vehicle: setupInsertParameter(value.vehicle, setup.vehicle),
	drivetrain: setupInsertParameter(value.drivetrain, setup.drivetrain),
	electronics: setupInsertParameter(value.electronics, setup.electronics),
	tires: setupInsertParameter(value.tires, setup.tires),
	shocks: setupInsertParameter(value.shocks, setup.shocks),
	frontSuspension: setupInsertParameter(
		value.frontSuspension,
		setup.frontSuspension,
	),
	rearSuspension: setupInsertParameter(
		value.rearSuspension,
		setup.rearSuspension,
	),
	notes: setupInsertParameter(value.notes, setup.notes),
	sourceUrl: setupInsertParameter(value.sourceUrl, setup.sourceUrl),
	sourcePdfReference: setupInsertParameter(
		value.sourcePdfReference,
		setup.sourcePdfReference,
	),
	sourceMetadata: setupInsertParameter(
		value.sourceMetadata,
		setup.sourceMetadata,
	),
	copiedFromId: setupInsertParameter(value.copiedFromId, setup.copiedFromId),
	rawValues: setupInsertParameter(value.rawValues, setup.rawValues),
	unmappedValues: setupInsertParameter(
		value.unmappedValues,
		setup.unmappedValues,
	),
	createdAt: setupInsertParameter(value.createdAt, setup.createdAt),
	updatedAt: setupInsertParameter(value.updatedAt, setup.updatedAt),
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
