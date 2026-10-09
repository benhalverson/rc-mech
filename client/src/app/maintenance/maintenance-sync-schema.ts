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
export const maintenanceCollectionSchema = z.object({
	carId: z.string(),
	version: z.number(),
	plans: z.array(planSnapshotSchema),
	records: z.array(serviceSnapshotSchema),
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
