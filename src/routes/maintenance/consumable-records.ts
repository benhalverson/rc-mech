import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { consumableMaintenanceEntry } from '../../schema';
import type { AppContext, ConsumableInput } from '../../types';
import { ownedCar } from '../cars/car-records';
import { jsonValue } from '../json-values';

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
