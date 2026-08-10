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

const nullableSetupContext = {
	name: setupContext.name,
	status: setupContext.status,
	setupDate: setupContext.setupDate.nullable(),
	track: setupContext.track.nullable(),
	event: setupContext.event.nullable(),
	surface: setupContext.surface.nullable(),
	traction: setupContext.traction.nullable(),
	moisture: setupContext.moisture.nullable(),
	condition: setupContext.condition.nullable(),
	temperature: setupContext.temperature.nullable(),
	vehicle: setupContext.vehicle.nullable(),
	drivetrain: setupContext.drivetrain.nullable(),
	electronics: setupContext.electronics.nullable(),
	tires: setupContext.tires.nullable(),
	shocks: setupContext.shocks.nullable(),
	frontSuspension: setupContext.frontSuspension.nullable(),
	rearSuspension: setupContext.rearSuspension.nullable(),
	notes: setupContext.notes.nullable(),
	sourceUrl: setupContext.sourceUrl.nullable(),
	sourcePdfReference: setupContext.sourcePdfReference.nullable(),
	sourceMetadata: setupContext.sourceMetadata.nullable(),
	rawValues: setupContext.rawValues.nullable(),
	unmappedValues: setupContext.unmappedValues.nullable(),
};

export const setupInput = z.object({
	...nullableSetupContext,
	makeCurrent: z.boolean().optional(),
});
export type SetupInput = z.infer<typeof setupInput>;

export const setupUpdateInput = z
	.object({
		...nullableSetupContext,
		name: setupContext.name.optional(),
		status: setupContext.status,
	})
	.refine(
		(value) => Object.keys(value).length > 0,
		'At least one setup field is required',
	);

export const setupCopyInput = setupInput.partial();

export const guardedSetupCopyInput = setupCopyInput
	.extend({
		expectedCurrentSetupId: z.string().min(1).max(160).optional(),
		expectedSourceUpdatedAt: z.string().datetime().optional(),
	})
	.refine(
		(value) =>
			(value.expectedCurrentSetupId === undefined) ===
			(value.expectedSourceUpdatedAt === undefined),
		{
			message:
				'Expected Current setup ID and source update time must be provided together',
		},
	);

export const setupImportSourceUrl = z
	.string()
	.trim()
	.url()
	.max(2000)
	.refine((value) => {
		const url = new URL(value);
		return (
			url.protocol === 'https:' &&
			(url.hostname === 'sodialed.com' ||
				url.hostname === 'www.sodialed.com') &&
			url.username === '' &&
			url.password === '' &&
			url.port === '' &&
			/^\/setup\/[A-Za-z0-9]+\/?$/.test(url.pathname)
		);
	}, 'Only supported So Dialed setup URLs are accepted');

const importValues = z.record(z.string().min(1).max(160), z.unknown());
const importDraftPatch = z.object({
	carId: z.string().min(1).max(160).nullable().optional(),
	knownValues: importValues.optional(),
	uncertainValues: importValues.optional(),
	rawValues: importValues.optional(),
	unmappedValues: importValues.optional(),
	sourceMetadata: importValues.optional(),
});

export const setupImportDraftInput = z.object({
	sourceUrl: setupImportSourceUrl,
	carId: z.string().min(1).max(160).optional(),
});
export const setupImportDraftUpdateInput = importDraftPatch.refine(
	(value) => Object.keys(value).length > 0,
	'At least one import draft field is required',
);
export const setupImportAcceptInput = z.object({
	carId: z.string().min(1).max(160),
	name: z.string().trim().min(1).max(160).optional(),
	makeCurrent: z.boolean().optional(),
});
export type SetupImportDraftInput = z.infer<typeof setupImportDraftInput>;
export type SetupImportDraftUpdateInput = z.infer<
	typeof setupImportDraftUpdateInput
>;

const costFields = {
	cost: z.number().finite().nonnegative().max(1_000_000_000),
	currency: z
		.string()
		.regex(/^[A-Za-z]{3}$/)
		.transform((value) => value.toUpperCase()),
};
const tireAxleInput = z
	.object({
		details: z
			.union([
				z.string().trim().min(1).max(4000),
				z.record(z.string(), z.unknown()),
			])
			.optional(),
		cost: costFields.cost.optional(),
		currency: costFields.currency.optional(),
	})
	.refine(
		(value) => (value.cost === undefined) === (value.currency === undefined),
		'Cost and currency must be supplied together',
	);

export const consumableKind = z.enum(['fluid', 'tires']);
export const fluidArea = z.enum([
	'front-shocks',
	'rear-shocks',
	'front-differential',
	'rear-differential',
	'custom',
]);
const consumableBase = {
	performedAt: z.string().datetime(),
	notes: z.string().max(4000).optional(),
	prefillFromCurrentSetup: z.boolean().optional(),
};
export const consumableInput = z
	.discriminatedUnion('kind', [
		z.object({
			...consumableBase,
			kind: z.literal('fluid'),
			fluidArea,
			customFluidArea: z.string().trim().min(1).max(160).optional(),
			cost: costFields.cost.optional(),
			currency: costFields.currency.optional(),
		}),
		z.object({
			...consumableBase,
			kind: z.literal('tires'),
			front: tireAxleInput.optional(),
			rear: tireAxleInput.optional(),
		}),
	])
	.superRefine((value, context) => {
		if (value.kind === 'fluid') {
			if (value.fluidArea === 'custom' && !value.customFluidArea)
				context.addIssue({
					code: 'custom',
					message: 'Custom fluid area is required',
					path: ['customFluidArea'],
				});
			if (value.fluidArea !== 'custom' && value.customFluidArea)
				context.addIssue({
					code: 'custom',
					message: 'Custom fluid area is only valid for custom',
					path: ['customFluidArea'],
				});
			if ((value.cost === undefined) !== (value.currency === undefined))
				context.addIssue({
					code: 'custom',
					message: 'Cost and currency must be supplied together',
					path: ['cost'],
				});
		} else if (!value.front && !value.rear && !value.prefillFromCurrentSetup)
			context.addIssue({
				code: 'custom',
				message: 'A front or rear tire set is required',
				path: ['front'],
			});
	});
export const consumableUpdateInput = z
	.object({
		performedAt: z.string().datetime().optional(),
		notes: z.string().max(4000).nullable().optional(),
		fluidArea: fluidArea.optional(),
		customFluidArea: z.string().trim().min(1).max(160).nullable().optional(),
		cost: costFields.cost.nullable().optional(),
		currency: costFields.currency.nullable().optional(),
		front: tireAxleInput.nullable().optional(),
		rear: tireAxleInput.nullable().optional(),
	})
	.refine(
		(value) => Object.keys(value).length > 0,
		'At least one consumable field is required',
	)
	.refine(
		(value) =>
			(value.cost === undefined && value.currency === undefined) ||
			(value.cost === null && value.currency === null) ||
			(value.cost !== undefined &&
				value.cost !== null &&
				value.currency !== undefined &&
				value.currency !== null),
		'Cost and currency must be supplied together',
	);
export type ConsumableInput = z.infer<typeof consumableInput>;
export type ConsumableUpdateInput = z.infer<typeof consumableUpdateInput>;

export const voiceConfidence = z.enum(['high', 'medium', 'low']);
const voiceFactBase = {
	confidence: voiceConfidence,
	needsReview: z.boolean(),
	sourceText: z.string().trim().min(1).max(2000),
};
export const voiceSetupSection = z.enum([
	'context',
	'vehicle',
	'drivetrain',
	'electronics',
	'tires',
	'shocks',
	'frontSuspension',
	'rearSuspension',
]);
export const voiceSetupChange = z.object({
	...voiceFactBase,
	section: voiceSetupSection,
	field: z.string().trim().min(1).max(160),
	value: z.union([z.string().max(4000), z.number().finite(), z.boolean()]),
});
export const voiceObservation = z.object({
	...voiceFactBase,
	text: z.string().trim().min(1).max(4000),
});
export const voiceCondition = z.object({
	...voiceFactBase,
	field: z.enum([
		'track',
		'event',
		'surface',
		'traction',
		'moisture',
		'condition',
		'temperature',
	]),
	value: z.string().trim().min(1).max(1000),
});
export const voiceConsumable = z
	.object({
		...voiceFactBase,
		kind: z.enum(['tires', 'fluid']),
		axle: z.enum(['front', 'rear', 'both']).optional(),
		details: z.string().trim().min(1).max(4000).optional(),
		fluidArea: fluidArea.optional(),
		customFluidArea: z.string().trim().min(1).max(160).optional(),
		notes: z.string().trim().min(1).max(4000).optional(),
	})
	.superRefine((value, context) => {
		if (value.kind === 'tires' && !value.axle)
			context.addIssue({
				code: 'custom',
				message: 'Tire changes require an axle',
				path: ['axle'],
			});
		if (value.kind === 'fluid' && !value.fluidArea)
			context.addIssue({
				code: 'custom',
				message: 'Fluid changes require an area',
				path: ['fluidArea'],
			});
		if (value.fluidArea === 'custom' && !value.customFluidArea)
			context.addIssue({
				code: 'custom',
				message: 'Custom fluid changes require an area name',
				path: ['customFluidArea'],
			});
	});

export const voiceDraftInput = z.object({
	setupChanges: z.array(voiceSetupChange).max(100),
	problems: z.array(voiceObservation).max(100),
	conditions: z.array(voiceCondition).max(100),
	driveSessionNotes: z.array(voiceObservation).max(100),
	consumables: z.array(voiceConsumable).max(100),
	unmappedNotes: z.array(z.string().trim().min(1).max(4000)).max(100),
	unresolvedNotes: z.array(z.string().trim().min(1).max(4000)).max(100),
});

export const voiceCaptureId = z.string().uuid();
export const VOICE_CORRECTION_MAX_LENGTH = 4000;
export const voiceTextCaptureInput = z.object({
	captureId: voiceCaptureId,
	text: z.string().trim().min(1).max(20_000),
	driveSessionId: z.string().min(1).max(160).nullable().optional(),
});
export const voiceContextUpdateInput = z
	.object({
		carId: z.string().min(1).max(160).optional(),
		driveSessionId: z.string().min(1).max(160).nullable().optional(),
		draft: voiceDraftInput.optional(),
		correction: z.string().trim().min(1).max(4000).optional(),
	})
	.refine(
		(value) => Object.keys(value).length > 0,
		'At least one voice update field is required',
	);
export const voiceCorrectionInput = z.object({
	text: z.string().trim().min(1).max(VOICE_CORRECTION_MAX_LENGTH),
});
export const voiceConfirmInput = z.object({
	acceptUnresolvedAsNotes: z.boolean().optional(),
});

export type VoiceDraft = z.infer<typeof voiceDraftInput>;
export type VoiceCorrectionInput = z.infer<typeof voiceCorrectionInput>;
