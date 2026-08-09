import {
	array,
	boolean,
	minLength,
	nullable,
	object,
	optional,
	record,
	string,
	unknown,
} from 'zod/mini';
import type * as z from 'zod/mini';

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
	copiedFromSetupId: optional(nullable(string())),
});

const collectionSchema = object({
	currentSetupId: optional(nullable(string())),
	setups: array(setupSchema),
});

export type CurrentSetupSnapshot = z.infer<typeof setupSchema> & {
	readonly copiedFromSetupId: string | null;
};

export type CurrentSetupCollection = {
	readonly currentSetupId: string | null;
	readonly setups: readonly CurrentSetupSnapshot[];
};

export type CurrentSetupReadoutRow = {
	readonly id: string;
	readonly label: string;
	readonly value: string;
};

export type CurrentSetupChange = {
	readonly id: string;
	readonly label: string;
	readonly previousValue: string;
	readonly currentValue: string;
};

export const parseCurrentSetupCollection = (
	value: unknown,
): CurrentSetupCollection => {
	const parsed = collectionSchema.safeParse(value);
	if (!parsed.success)
		throw new Error('The current setup response was invalid.');
	return {
		currentSetupId: parsed.data.currentSetupId ?? null,
		setups: parsed.data.setups.map((setup) => ({
			...setup,
			copiedFromSetupId: setup.copiedFromSetupId ?? null,
		})),
	};
};
