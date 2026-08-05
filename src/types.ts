import type { Context } from 'hono';
import { z } from 'zod';

export type AppVariables = { userId: string };
export type AppEnv = { Bindings: Env; Variables: AppVariables };
export type AppContext = Context<AppEnv>;

const carFields = {
	name: z.string().min(1).max(120),
	make: z.string().max(120).optional(),
	model: z.string().max(120).optional(),
	scale: z.string().max(20).optional(),
	vehicleType: z.string().max(80).optional(),
	powerType: z.string().max(80).optional(),
	notes: z.string().max(4000).optional(),
};

export const carInput = z.object(carFields);
export const carUpdateInput = z
	.object({
		name: carFields.name.optional(),
		make: carFields.make,
		model: carFields.model,
		scale: carFields.scale,
		vehicleType: carFields.vehicleType,
		powerType: carFields.powerType,
		notes: carFields.notes,
	})
	.refine(
		(value) => Object.keys(value).length > 0,
		'At least one car field is required',
	);

export const componentInput = z.object({
	slot: z.string().trim().min(1).max(80),
	slotType: z.enum(['standard', 'custom']).optional(),
	name: z.string().min(1).max(160),
	manufacturer: z.string().max(120).optional(),
	model: z.string().max(120).optional(),
	serialNumber: z.string().max(120).optional(),
	notes: z.string().max(4000).optional(),
	installedAt: z.string().datetime().optional(),
});

export const componentUpdateInput = z
	.object({
		name: z.string().min(1).max(160).optional(),
		manufacturer: z.string().max(120).optional(),
		model: z.string().max(120).optional(),
		serialNumber: z.string().max(120).optional(),
		notes: z.string().max(4000).optional(),
		installedAt: z.string().datetime().optional(),
	})
	.refine(
		(value) => Object.keys(value).length > 0,
		'At least one component field is required',
	);

export const driveSessionInput = z.object({
	startedAt: z.string().datetime(),
	durationMinutes: z.number().int().positive().max(1440).optional(),
	conditions: z.string().max(1000).optional(),
	notes: z.string().max(4000).optional(),
});

export const driveSessionUpdateInput = z
	.object({
		startedAt: z.string().datetime().optional(),
		durationMinutes: z
			.number()
			.int()
			.positive()
			.max(1440)
			.nullable()
			.optional(),
		conditions: z.string().max(1000).nullable().optional(),
		notes: z.string().max(4000).nullable().optional(),
	})
	.refine(
		(value) => Object.keys(value).length > 0,
		'At least one drive session field is required',
	);

export const timezoneInput = z.object({ timezone: z.string().min(1).max(100) });

export const serviceRecordInput = z
	.object({
		carId: z.string().min(1),
		componentId: z.string().optional(),
		performedAt: z.string().datetime(),
		description: z.string().min(1).max(4000).optional(),
		notes: z.string().min(1).max(4000).optional(),
		cost: z.number().finite().nonnegative().max(1000000000).optional(),
		currency: z
			.string()
			.regex(/^[A-Za-z]{3}$/)
			.transform((value) => value.toUpperCase())
			.optional(),
		baselineAt: z.string().datetime().optional(),
	})
	.refine(
		(value) => value.description !== undefined || value.notes !== undefined,
		'Description or notes is required',
	)
	.refine(
		(value) => (value.cost === undefined) === (value.currency === undefined),
		'Cost and currency must be supplied together',
	);

export const serviceRecordUpdateInput = z
	.object({
		performedAt: z.string().datetime().optional(),
		description: z.string().min(1).max(4000).optional(),
		notes: z.string().min(1).max(4000).nullable().optional(),
		cost: z
			.number()
			.finite()
			.nonnegative()
			.max(1000000000)
			.nullable()
			.optional(),
		currency: z
			.string()
			.regex(/^[A-Za-z]{3}$/)
			.transform((value) => value.toUpperCase())
			.nullable()
			.optional(),
	})
	.refine(
		(value) => Object.keys(value).length > 0,
		'At least one service record field is required',
	)
	.refine(
		(value) =>
			(value.cost === undefined && value.currency === undefined) ||
			(value.cost === null && value.currency === null) ||
			(value.cost !== null &&
				value.cost !== undefined &&
				value.currency !== null &&
				value.currency !== undefined),
		'Cost and currency must be supplied together',
	);

export const maintenancePlanInput = z
	.object({
		carId: z.string().min(1),
		componentId: z.string().min(1).optional(),
		name: z.string().min(1).max(160),
		intervalUnit: z.enum(['none', 'days', 'weeks', 'months']).optional(),
		intervalValue: z.number().int().positive().optional(),
		intervalDays: z.number().int().positive().optional(),
		intervalSessions: z.number().int().positive().optional(),
		baselineAt: z.string().datetime().optional(),
		baselineSessionCount: z.number().int().nonnegative().optional(),
	})
	.refine(
		(value) =>
			value.intervalValue !== undefined ||
			value.intervalDays !== undefined ||
			value.intervalSessions !== undefined,
		'An interval is required',
	)
	.refine(
		(value) =>
			value.intervalValue === undefined || value.intervalUnit !== undefined,
		'intervalUnit is required when intervalValue is supplied',
	);

export const maintenancePlanUpdateInput = z
	.object({
		name: z.string().min(1).max(160).optional(),
		intervalUnit: z.enum(['none', 'days', 'weeks', 'months']).optional(),
		intervalValue: z.number().int().positive().optional(),
		intervalDays: z.number().int().positive().nullable().optional(),
		intervalSessions: z.number().int().positive().nullable().optional(),
	})
	.refine(
		(value) => Object.keys(value).length > 0,
		'At least one plan field is required',
	);
export const maintenanceCompletionInput = z
	.object({
		performedAt: z.string().datetime().optional(),
		description: z.string().min(1).max(4000).optional(),
		notes: z.string().min(1).max(4000).optional(),
		cost: z.number().finite().nonnegative().max(1000000000).optional(),
		currency: z
			.string()
			.regex(/^[A-Za-z]{3}$/)
			.transform((value) => value.toUpperCase())
			.optional(),
	})
	.refine(
		(value) => (value.cost === undefined) === (value.currency === undefined),
		'Cost and currency must be supplied together',
	);

export const photoUpdateInput = z
	.object({
		sortOrder: z.number().int().nonnegative().max(10000).optional(),
		isPrimary: z.boolean().optional(),
	})
	.refine(
		(value) => Object.keys(value).length > 0,
		'At least one photo field is required',
	);

export const photoReorderInput = z.object({
	photoIds: z.array(z.string().min(1)).max(1000),
});

const setupSection = z.record(z.string().min(1).max(120), z.unknown());
const setupContext = {
	name: z.string().trim().min(1).max(160),
	status: z.enum(['draft', 'reviewed', 'active']).optional(),
	setupDate: z.string().datetime().optional(),
	track: z.string().max(160).optional(),
	event: z.string().max(160).optional(),
	surface: z.string().max(120).optional(),
	traction: z.string().max(120).optional(),
	moisture: z.string().max(120).optional(),
	condition: z.string().max(120).optional(),
	temperature: z.string().max(80).optional(),
	vehicle: setupSection.optional(),
	drivetrain: setupSection.optional(),
	electronics: setupSection.optional(),
	tires: setupSection.optional(),
	shocks: setupSection.optional(),
	frontSuspension: setupSection.optional(),
	rearSuspension: setupSection.optional(),
	notes: z.string().max(10000).optional(),
	sourceUrl: z.string().url().max(2000).optional(),
	sourcePdfReference: z.string().max(2000).optional(),
	sourceMetadata: setupSection.optional(),
	rawValues: setupSection.optional(),
	unmappedValues: setupSection.optional(),
};

const nullableSetupContext = Object.fromEntries(
	Object.entries(setupContext).map(([key, value]) => [
		key,
		key === 'name' || key === 'status'
			? value
			: (value as z.ZodTypeAny).nullable().optional(),
	]),
) as typeof setupContext;

export const setupInput = z.object({
	...nullableSetupContext,
	makeCurrent: z.boolean().optional(),
});
export type SetupInput = z.infer<typeof setupInput>;

export const setupUpdateInput = z
	.object({
		...Object.fromEntries(
			Object.entries(nullableSetupContext).map(([key, value]) => [
				key,
				key === 'name' || key === 'status'
					? (
							setupContext[key as keyof typeof setupContext] as z.ZodTypeAny
						).optional()
					: value,
			]),
		),
	})
	.refine(
		(value) => Object.keys(value).length > 0,
		'At least one setup field is required',
	);

export const setupCopyInput = setupInput.partial();
