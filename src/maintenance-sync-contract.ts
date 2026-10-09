import { z } from 'zod';
import { consumableChangeInput } from './consumable-sync-contract';

const identity = { id: z.uuid(), carId: z.uuid() };
export const maintenancePlanSnapshot = z
	.object({
		...identity,
		componentId: z.uuid().nullable(),
		name: z.string().min(1).max(160),
		intervalDays: z.number().int().positive().nullable(),
		intervalSessions: z.number().int().positive().nullable(),
		intervalUnit: z.enum(['none', 'days', 'weeks', 'months']),
		intervalValue: z.number().int().positive(),
		baselineAt: z.iso.datetime(),
		baselineSessionCount: z.number().int().nonnegative(),
		status: z.enum(['active', 'paused', 'archived']),
		pauseReason: z.string().nullable(),
		pausedAt: z.string().nullable(),
	})
	.strict();
export const serviceRecordSnapshot = z
	.object({
		...identity,
		componentId: z.uuid().nullable(),
		planId: z.uuid().nullable(),
		performedAt: z.iso.datetime(),
		description: z.string().min(1).max(2000),
		notes: z.string().max(4000).nullable(),
		cost: z.number().nonnegative().nullable(),
		currency: z.string().length(3).nullable(),
		baselineAt: z.iso.datetime(),
		baselineSessionCount: z.number().int().nonnegative().nullable(),
		previousBaselineAt: z.string().nullable(),
		previousBaselineSessionCount: z.number().int().nonnegative().nullable(),
		deletedAt: z.string().nullable(),
	})
	.strict();
const common = {
	type: z.literal('maintenance.change'),
	carId: z.uuid(),
	baseVersion: z.number().int().nonnegative(),
};
export const maintenanceSyncCommandInput = z.discriminatedUnion('entity', [
	consumableChangeInput,
	z
		.object({
			...common,
			entity: z.literal('plan'),
			action: z.enum(['save', 'pause', 'resume', 'archive', 'restore']),
			planId: z.uuid(),
			base: maintenancePlanSnapshot.nullable(),
			input: maintenancePlanSnapshot.omit({
				id: true,
				carId: true,
				status: true,
				pauseReason: true,
				pausedAt: true,
			}),
		})
		.strict(),
	z
		.object({
			...common,
			entity: z.literal('service'),
			baselineSessionCount: z.number().int().nonnegative(),
			action: z.enum(['save', 'archive', 'restore']),
			recordId: z.uuid(),
			base: serviceRecordSnapshot.nullable(),
			planBase: maintenancePlanSnapshot.nullable(),
			input: serviceRecordSnapshot.pick({
				componentId: true,
				performedAt: true,
				description: true,
				notes: true,
				cost: true,
				currency: true,
			}),
		})
		.strict(),
]);
