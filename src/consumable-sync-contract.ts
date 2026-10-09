import { z } from 'zod';

const text = z.string().nullable();
const money = z.number().nonnegative().nullable();
export const consumableSnapshot = z
	.object({
		id: z.uuid(),
		carId: z.uuid(),
		kind: z.enum(['tires', 'fluid']),
		performedAt: z.iso.datetime(),
		fluidArea: z
			.enum([
				'front-shocks',
				'rear-shocks',
				'front-differential',
				'rear-differential',
				'custom',
			])
			.nullable(),
		customFluidArea: text,
		frontDetails: text,
		frontCost: money,
		frontCurrency: text,
		rearDetails: text,
		rearCost: money,
		rearCurrency: text,
		cost: money,
		currency: text,
		notes: text,
		prefilledFromSetupId: z.uuid().nullable(),
		archivedAt: text,
		createdAt: z.iso.datetime(),
		updatedAt: z.iso.datetime(),
	})
	.strict();
export const consumableChangeInput = z
	.object({
		type: z.literal('maintenance.change'),
		entity: z.literal('consumable'),
		carId: z.uuid(),
		baseVersion: z.number().int().nonnegative(),
		entryId: z.uuid(),
		action: z.enum(['save', 'archive', 'restore']),
		base: consumableSnapshot.nullable(),
		input: consumableSnapshot.omit({
			id: true,
			carId: true,
			archivedAt: true,
			createdAt: true,
			updatedAt: true,
			prefilledFromSetupId: true,
		}),
	})
	.strict();
