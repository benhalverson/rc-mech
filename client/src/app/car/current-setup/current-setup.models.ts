import type * as z from 'zod/mini';
import {
	array,
	boolean,
	minLength,
	nullable,
	number,
	object,
	optional,
	record,
	string,
	unknown,
} from 'zod/mini';

export const currentSetupSectionKeys = [
	'vehicle',
	'drivetrain',
	'electronics',
	'tires',
	'shocks',
	'frontSuspension',
	'rearSuspension',
	'notes',
] as const;

export type CurrentSetupSectionKey = (typeof currentSetupSectionKeys)[number];

const sectionSchema = record(string(), unknown());
const contextSchema = object({
	recordedAt: optional(nullable(string())),
	track: optional(nullable(string())),
	event: optional(nullable(string())),
	surface: optional(nullable(string())),
	traction: optional(nullable(string())),
	moisture: optional(nullable(string())),
	condition: optional(nullable(string())),
	temperature: optional(nullable(string())),
});

const sourceSchema = object({
	url: optional(nullable(string())),
	pdfUrl: optional(nullable(string())),
	pdfTitle: optional(nullable(string())),
	pdfPage: optional(nullable(number())),
});

const setupSchema = object({
	id: string().check(minLength(1)),
	carId: string().check(minLength(1)),
	name: string().check(minLength(1)),
	current: boolean(),
	context: contextSchema,
	sections: object({
		vehicle: sectionSchema,
		drivetrain: sectionSchema,
		electronics: sectionSchema,
		tires: sectionSchema,
		shocks: sectionSchema,
		frontSuspension: sectionSchema,
		rearSuspension: sectionSchema,
		notes: sectionSchema,
	}),
	source: optional(nullable(sourceSchema)),
	copiedFromSetupId: optional(nullable(string())),
	unmappedValues: optional(nullable(sectionSchema)),
	rawValues: optional(nullable(sectionSchema)),
	createdAt: optional(string()),
	updatedAt: optional(string()),
	version: optional(number()),
});

const collectionSchema = object({
	currentSetupId: optional(nullable(string())),
	currentSetupVersion: optional(number()),
	setups: array(setupSchema),
});

const mutationSchema = object({ setup: setupSchema });

const timezoneSchema = object({ timezone: optional(nullable(string())) });

export type CurrentSetupSnapshot = z.infer<typeof setupSchema> & {
	readonly copiedFromSetupId: string | null;
};

export type CurrentSetupCollection = {
	readonly currentSetupId: string | null;
	readonly currentSetupVersion?: number;
	readonly setups: readonly CurrentSetupSnapshot[];
};

export type CurrentSetupReadoutRow = {
	readonly id: string;
	readonly label: string;
	readonly value: string;
	readonly focusField: string;
	readonly segments?: readonly {
		readonly label: string;
		readonly value: string;
		readonly focusField: string;
	}[];
};

export type CurrentSetupChange = {
	readonly id: string;
	readonly label: string;
	readonly previousValue: string;
	readonly currentValue: string;
};

export type SetupChangeDraft = {
	readonly name: string;
	readonly recordedAt: string | null;
	readonly track: string | null;
	readonly event: string | null;
	readonly surface: string | null;
	readonly traction: string | null;
	readonly moisture: string | null;
	readonly condition: string | null;
	readonly temperature: string | null;
	readonly sections: Readonly<
		Record<CurrentSetupSectionKey, Readonly<Record<string, unknown>>>
	>;
};

export type SaveCurrentSetupCommand = {
	readonly carId: string;
	readonly sourceSetupId: string;
	readonly sourceUpdatedAt: string;
	readonly draft: SetupChangeDraft;
};

export type CurrentSetupGatewayFailure =
	| { readonly kind: 'http'; readonly status: number }
	| {
			readonly kind: 'rejected-response';
			readonly status: number;
			readonly message: string;
	  }
	| { readonly kind: 'unavailable' }
	| { readonly kind: 'invalid-response' };

export type CurrentSetupSaveFailure =
	| CurrentSetupGatewayFailure
	| { readonly kind: 'invalid-command' }
	| { readonly kind: 'stale-current' }
	| { readonly kind: 'local'; readonly message: string }
	| { readonly kind: 'needs-attention'; readonly message: string }
	| { readonly kind: 'conflict'; readonly message: string };

export type CurrentSetupSaveOutcome =
	| {
			readonly status: 'idle';
			readonly operation: 'save-current-setup';
			readonly operationId: null;
	  }
	| {
			readonly status: 'pending';
			readonly operation: 'save-current-setup';
			readonly operationId: number;
	  }
	| {
			readonly status: 'succeeded';
			readonly operation: 'save-current-setup';
			readonly operationId: number;
			readonly setup: CurrentSetupSnapshot;
			readonly retainedLocally: boolean;
	  }
	| {
			readonly status: 'failed';
			readonly operation: 'save-current-setup';
			readonly operationId: number;
			readonly error: CurrentSetupSaveFailure;
	  };

const normalizeSetup = (
	setup: z.infer<typeof setupSchema>,
): CurrentSetupSnapshot => ({
	...setup,
	copiedFromSetupId: setup.copiedFromSetupId ?? null,
});

export const parseCurrentSetupCollection = (
	value: unknown,
): CurrentSetupCollection => {
	const parsed = collectionSchema.safeParse(value);
	if (!parsed.success)
		throw new Error('The current setup response was invalid.');
	return {
		currentSetupId: parsed.data.currentSetupId ?? null,
		currentSetupVersion: parsed.data.currentSetupVersion ?? 0,
		setups: parsed.data.setups.map(normalizeSetup),
	};
};

export const parseCurrentSetupMutation = (
	value: unknown,
): CurrentSetupSnapshot => {
	const parsed = mutationSchema.safeParse(value);
	if (!parsed.success)
		throw new Error('The current setup mutation response was invalid.');
	return normalizeSetup(parsed.data.setup);
};

export const parseCurrentSetupTimezone = (
	value: unknown,
): { readonly timezone: string | null } => {
	const parsed = timezoneSchema.safeParse(value);
	if (!parsed.success)
		throw new Error('The current setup timezone response was invalid.');
	return { timezone: parsed.data.timezone ?? null };
};
