import { z } from 'zod';

const driveFields = {
	startedAt: z.string().datetime(),
	durationMinutes: z.number().int().positive().max(1440).nullable(),
	conditions: z.string().max(1000).nullable(),
	notes: z.string().max(4000).nullable(),
};
export const driveSyncCommandInput = z
	.object({
		type: z.literal('drive.change'),
		action: z.enum(['save', 'archive']),
		carId: z.string().uuid(),
		sessionId: z.string().uuid(),
		baseVersion: z.number().int().nonnegative(),
		base: z
			.object({
				id: z.string().uuid(),
				carId: z.string().uuid(),
				...driveFields,
				deletedAt: z.string().nullable(),
			})
			.strict()
			.nullable(),
		input: z.object(driveFields).strict(),
	})
	.strict();
