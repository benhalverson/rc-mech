/**
 * Canonical plan/service snapshot parsing used by Maintenance preparation and acknowledgement; transport data is checked before entering the working copy.
 */

import * as z from 'zod/mini';

const identity = { id: z.string(), carId: z.string() };
const nullableString = z.nullable(z.string());
const nullableNumber = z.nullable(z.number());
export const planSnapshotSchema = z.object({
	...identity,
	componentId: nullableString,
	name: z.string(),
	intervalDays: nullableNumber,
	intervalSessions: nullableNumber,
	intervalUnit: z.enum(['none', 'days', 'weeks', 'months']),
	intervalValue: z.number(),
	baselineAt: z.string(),
	baselineSessionCount: z.number(),
	status: z.enum(['active', 'paused', 'archived']),
	pauseReason: nullableString,
	pausedAt: nullableString,
});
export const serviceSnapshotSchema = z.object({
	...identity,
	componentId: nullableString,
	planId: nullableString,
	performedAt: z.string(),
	description: z.string(),
	notes: nullableString,
	cost: nullableNumber,
	currency: nullableString,
	baselineAt: z.string(),
	baselineSessionCount: nullableNumber,
	previousBaselineAt: nullableString,
	previousBaselineSessionCount: nullableNumber,
	deletedAt: nullableString,
});
export const consumableSnapshotSchema = z.object({
	...identity,
	kind: z.enum(['tires', 'fluid']),
	performedAt: z.string(),
	fluidArea: z.nullable(
		z.enum([
			'front-shocks',
			'rear-shocks',
			'front-differential',
			'rear-differential',
			'custom',
		]),
	),
	customFluidArea: nullableString,
	frontDetails: nullableString,
	frontCost: nullableNumber,
	frontCurrency: nullableString,
	rearDetails: nullableString,
	rearCost: nullableNumber,
	rearCurrency: nullableString,
	cost: nullableNumber,
	currency: nullableString,
	notes: nullableString,
	prefilledFromSetupId: nullableString,
	archivedAt: nullableString,
	createdAt: z.string(),
	updatedAt: z.string(),
});
export const maintenanceCollectionSchema = z.object({
	carId: z.string(),
	version: z.number(),
	plans: z.array(planSnapshotSchema),
	records: z.array(serviceSnapshotSchema),
	consumables: z.optional(z.array(consumableSnapshotSchema)),
});
export const maintenanceSnapshotSchema = z.object({
	collections: z.array(maintenanceCollectionSchema),
	components: z.array(
		z.object({
			...identity,
			slot: z.string(),
			name: z.string(),
			removedAt: nullableString,
		}),
	),
	timezone: z.string(),
});
