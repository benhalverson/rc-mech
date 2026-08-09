import type {
	CurrentSetupSectionKey,
	CurrentSetupSnapshot,
	SetupChangeDraft,
} from './current-setup.models';
import { displaySetupValue, setupFieldLabel } from './current-setup.rules';

export type SetupChangeFormSections = Record<
	CurrentSetupSectionKey,
	Record<string, string>
>;

export type SetupChangeFormModel = {
	name: string;
	recordedAt: string;
	track: string;
	event: string;
	surface: string;
	traction: string;
	moisture: string;
	condition: string;
	temperature: string;
	sections: SetupChangeFormSections;
};

export type SetupChangeEditorField = {
	readonly id: string;
	readonly section: CurrentSetupSectionKey;
	readonly field: string;
	readonly label: string;
};

export type SetupChangeEditorGroup = {
	readonly section: CurrentSetupSectionKey;
	readonly label: string;
	readonly fields: readonly SetupChangeEditorField[];
};

type KnownField = {
	readonly section: CurrentSetupSectionKey;
	readonly field: string;
	readonly aliases: readonly string[];
};

const knownFields: readonly KnownField[] = [
	{
		section: 'vehicle',
		field: 'rideHeight',
		aliases: ['rideHeight', 'chassisRideHeight'],
	},
	{
		section: 'frontSuspension',
		field: 'camber',
		aliases: ['camber', 'frontCamber'],
	},
	{
		section: 'rearSuspension',
		field: 'camber',
		aliases: ['camber', 'rearCamber'],
	},
	{
		section: 'frontSuspension',
		field: 'toe',
		aliases: ['toe', 'frontToe'],
	},
	{
		section: 'rearSuspension',
		field: 'cBlockPill',
		aliases: ['cBlockPill', 'cBlockPillPosition', 'rearCBlockPill'],
	},
	{
		section: 'rearSuspension',
		field: 'dBlockPill',
		aliases: ['dBlockPill', 'dBlockPillPosition', 'rearDBlockPill'],
	},
	{
		section: 'shocks',
		field: 'frontSpring',
		aliases: ['frontSpring', 'frontShockSpring'],
	},
	{
		section: 'shocks',
		field: 'frontOil',
		aliases: ['frontOil', 'frontShockOil'],
	},
	{
		section: 'shocks',
		field: 'rearSpring',
		aliases: ['rearSpring', 'rearShockSpring'],
	},
	{
		section: 'shocks',
		field: 'rearOil',
		aliases: ['rearOil', 'rearShockOil'],
	},
	{
		section: 'drivetrain',
		field: 'driveType',
		aliases: [
			'driveType',
			'configuration',
			'drivetrainConfiguration',
			'layout',
		],
	},
	{
		section: 'drivetrain',
		field: 'gearDiffOil',
		aliases: ['gearDiffOil', 'gearDifferentialOil', 'diffOil'],
	},
	{
		section: 'drivetrain',
		field: 'gearDiffHeight',
		aliases: ['gearDiffHeight', 'gearDifferentialHeight', 'diffHeight'],
	},
	{
		section: 'drivetrain',
		field: 'frontDiffOil',
		aliases: ['frontDiffOil', 'frontDifferentialOil'],
	},
	{
		section: 'drivetrain',
		field: 'centerDiffOil',
		aliases: ['centerDiffOil', 'centerDifferentialOil'],
	},
	{
		section: 'drivetrain',
		field: 'rearDiffOil',
		aliases: ['rearDiffOil', 'rearDifferentialOil'],
	},
	{
		section: 'drivetrain',
		field: 'centerSlipper',
		aliases: ['centerSlipper', 'centerDrive', 'centerDriveConfiguration'],
	},
];

const remainingKnownFields: Readonly<
	Record<CurrentSetupSectionKey, readonly string[]>
> = {
	vehicle: ['weight', 'wheelbase'],
	drivetrain: ['motor', 'pinion', 'spur'],
	electronics: ['esc', 'escSettings', 'servo', 'battery'],
	tires: ['front', 'rear', 'insert', 'wheels'],
	shocks: [],
	frontSuspension: ['caster', 'swayBar'],
	rearSuspension: ['swayBar', 'antiSquat'],
	notes: ['setupNotes'],
};

const sectionLabels: Record<CurrentSetupSectionKey, string> = {
	vehicle: 'Vehicle',
	drivetrain: 'Drivetrain',
	electronics: 'Electronics',
	tires: 'Tires',
	shocks: 'Shocks',
	frontSuspension: 'Front suspension',
	rearSuspension: 'Rear suspension',
	notes: 'Notes',
};

const aliasesBySection = new Map<CurrentSetupSectionKey, Set<string>>();
for (const known of knownFields) {
	const aliases = aliasesBySection.get(known.section) ?? new Set<string>();
	for (const alias of known.aliases) aliases.add(alias);
	aliasesBySection.set(known.section, aliases);
}

const knownByCanonicalId = new Map(
	knownFields.map((field) => [`${field.section}.${field.field}`, field]),
);

const sourceValue = (
	setup: CurrentSetupSnapshot,
	field: KnownField,
): unknown => {
	for (const alias of field.aliases)
		if (Object.hasOwn(setup.sections[field.section], alias))
			return setup.sections[field.section][alias];
	return undefined;
};

const editableValue = (value: unknown): string =>
	value === null || value === undefined || value === ''
		? ''
		: displaySetupValue(value);

const emptySections = (): SetupChangeFormSections => ({
	vehicle: {},
	drivetrain: {},
	electronics: {},
	tires: {},
	shocks: {},
	frontSuspension: {},
	rearSuspension: {},
	notes: {},
});

export const emptySetupChangeForm = (): SetupChangeFormModel => ({
	name: '',
	recordedAt: '',
	track: '',
	event: '',
	surface: '',
	traction: '',
	moisture: '',
	condition: '',
	temperature: '',
	sections: emptySections(),
});

export const browserTimezone = (): string => {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch {
		return 'UTC';
	}
};

export const validTimezone = (timezone: string): boolean => {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
		return true;
	} catch {
		return false;
	}
};

export const resolveSetupTimezone = (timezone: string | null): string =>
	timezone && validTimezone(timezone) ? timezone : browserTimezone();

export const setupChangeName = (
	previousName: string,
	now: Date,
	timezone: string,
): string => {
	const timestamp = new Intl.DateTimeFormat('en-US', {
		timeZone: validTimezone(timezone) ? timezone : 'UTC',
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	}).format(now);
	const suffix = ` · ${timestamp}`;
	return `${previousName.slice(0, 160 - suffix.length).trimEnd()}${suffix}`;
};

export const setupDateAt = (now: Date, timezone: string): string => {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: validTimezone(timezone) ? timezone : 'UTC',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).formatToParts(now);
	const value = (type: Intl.DateTimeFormatPartTypes): string =>
		parts.find((part) => part.type === type)?.value ?? '';
	return `${value('year')}-${value('month')}-${value('day')}`;
};

export const setupChangeFormFromSnapshot = (
	setup: CurrentSetupSnapshot,
	now: Date,
	timezone: string,
): SetupChangeFormModel => {
	const sections = emptySections();
	for (const [section, values] of Object.entries(setup.sections) as Array<
		[CurrentSetupSectionKey, Record<string, unknown>]
	>) {
		const aliases = aliasesBySection.get(section) ?? new Set<string>();
		for (const [field, value] of Object.entries(values))
			if (
				!aliases.has(field) &&
				!(section === 'rearSuspension' && field === 'toe')
			)
				sections[section][field] = editableValue(value);
		for (const field of remainingKnownFields[section])
			sections[section][field] ??= '';
	}
	for (const field of knownFields)
		sections[field.section][field.field] = editableValue(
			sourceValue(setup, field),
		);
	return {
		name: setupChangeName(setup.name, now, timezone),
		recordedAt: setupDateAt(now, timezone),
		track: setup.context.track ?? '',
		event: setup.context.event ?? '',
		surface: setup.context.surface ?? '',
		traction: setup.context.traction ?? '',
		moisture: setup.context.moisture ?? '',
		condition: setup.context.condition ?? '',
		temperature: setup.context.temperature ?? '',
		sections,
	};
};

const optional = (value: string): string | null => value.trim() || null;

const sectionDraft = (
	setup: CurrentSetupSnapshot,
	section: CurrentSetupSectionKey,
	form: Record<string, string>,
): Readonly<Record<string, unknown>> => {
	const result: Record<string, unknown> = { ...setup.sections[section] };
	for (const [field, nextValue] of Object.entries(form)) {
		const known = knownByCanonicalId.get(`${section}.${field}`);
		const previous = known
			? sourceValue(setup, known)
			: setup.sections[section][field];
		if (nextValue === editableValue(previous)) continue;
		if (known) for (const alias of known.aliases) delete result[alias];
		else delete result[field];
		const trimmed = nextValue.trim();
		if (trimmed) result[known?.field ?? field] = trimmed;
	}
	return result;
};

export const setupChangeDraftFromForm = (
	setup: CurrentSetupSnapshot,
	form: SetupChangeFormModel,
): SetupChangeDraft => ({
	name: form.name.trim(),
	recordedAt: form.recordedAt
		? new Date(`${form.recordedAt}T00:00:00.000Z`).toISOString()
		: null,
	track: optional(form.track),
	event: optional(form.event),
	surface: optional(form.surface),
	traction: optional(form.traction),
	moisture: optional(form.moisture),
	condition: optional(form.condition),
	temperature: optional(form.temperature),
	sections: {
		vehicle: sectionDraft(setup, 'vehicle', form.sections.vehicle),
		drivetrain: sectionDraft(setup, 'drivetrain', form.sections.drivetrain),
		electronics: sectionDraft(setup, 'electronics', form.sections.electronics),
		tires: sectionDraft(setup, 'tires', form.sections.tires),
		shocks: sectionDraft(setup, 'shocks', form.sections.shocks),
		frontSuspension: sectionDraft(
			setup,
			'frontSuspension',
			form.sections.frontSuspension,
		),
		rearSuspension: sectionDraft(
			setup,
			'rearSuspension',
			form.sections.rearSuspension,
		),
		notes: sectionDraft(setup, 'notes', form.sections.notes),
	},
});

export const setupChangeRemainingGroups = (
	setup: CurrentSetupSnapshot,
): readonly SetupChangeEditorGroup[] => {
	const groups: SetupChangeEditorGroup[] = [];
	for (const [section, values] of Object.entries(setup.sections) as Array<
		[CurrentSetupSectionKey, Record<string, unknown>]
	>) {
		const excluded = aliasesBySection.get(section) ?? new Set<string>();
		const fields = new Set(remainingKnownFields[section]);
		for (const field of Object.keys(values))
			if (
				!excluded.has(field) &&
				!(section === 'rearSuspension' && field === 'toe')
			)
				fields.add(field);
		const editorFields = [...fields]
			.sort((left, right) => left.localeCompare(right))
			.map((field) => ({
				id: `${section}.${field}`,
				section,
				field,
				label: setupFieldLabel(field),
			}));
		if (editorFields.length)
			groups.push({
				section,
				label: sectionLabels[section],
				fields: editorFields,
			});
	}
	return groups;
};
