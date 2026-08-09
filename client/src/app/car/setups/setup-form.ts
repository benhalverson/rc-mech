import {
	type SetupSectionKey,
	type SetupSections,
	type SetupSnapshot,
	type SetupSnapshotDraft,
	type SoDialedImportPreview,
	setupSectionKeys,
} from './setup-snapshot';
import type { SetupWorkflowCommand } from './setup-snapshot-store';

type SetupFormSections = Record<SetupSectionKey, Record<string, string>>;

export type SetupFormModel = {
	name: string;
	recordedAt: string;
	track: string;
	event: string;
	surface: string;
	traction: string;
	moisture: string;
	condition: string;
	temperature: string;
	sourceUrl: string;
	pdfUrl: string;
	pdfTitle: string;
	pdfPage: string;
	sections: SetupFormSections;
	unmappedValues: string;
	rawValues: string;
};

export const setupSectionFields = {
	vehicle: ['rideHeight', 'weight', 'wheelbase'],
	drivetrain: [
		'motor',
		'pinion',
		'spur',
		'driveType',
		'gearDiffOil',
		'gearDiffHeight',
		'diffOil',
		'frontDiffOil',
		'centerDiffOil',
		'rearDiffOil',
		'centerSlipper',
	],
	electronics: ['esc', 'escSettings', 'servo', 'battery'],
	tires: ['front', 'rear', 'insert', 'wheels'],
	shocks: ['frontOil', 'rearOil', 'frontSpring', 'rearSpring'],
	frontSuspension: ['camber', 'caster', 'toe', 'swayBar'],
	rearSuspension: [
		'camber',
		'toe',
		'cBlockPill',
		'dBlockPill',
		'swayBar',
		'antiSquat',
	],
	notes: ['setupNotes'],
} as const;

export const setupSectionLabels: Record<SetupSectionKey, string> = {
	vehicle: 'Vehicle',
	drivetrain: 'Drivetrain',
	electronics: 'Electronics',
	tires: 'Tires',
	shocks: 'Shocks',
	frontSuspension: 'Front suspension',
	rearSuspension: 'Rear suspension',
	notes: 'Notes',
};

export const setupFieldLabel = (field: string): string =>
	field
		.replace(/([A-Z])/g, ' $1')
		.replace(/^./, (letter) => letter.toUpperCase());

const emptySections = (): SetupFormSections =>
	Object.fromEntries(
		setupSectionKeys.map((key) => [
			key,
			Object.fromEntries(setupSectionFields[key].map((field) => [field, ''])),
		]),
	) as SetupFormSections;

const editableSections = (sections: SetupSections): SetupFormSections => {
	const defaults = emptySections();
	return Object.fromEntries(
		setupSectionKeys.map((key) => [
			key,
			{
				...defaults[key],
				...Object.fromEntries(
					Object.entries(sections[key] ?? {}).map(([field, value]) => [
						field,
						value ?? '',
					]),
				),
			},
		]),
	) as SetupFormSections;
};

export const emptySetupForm = (): SetupFormModel => ({
	name: '',
	recordedAt: '',
	track: '',
	event: '',
	surface: '',
	traction: '',
	moisture: '',
	condition: '',
	temperature: '',
	sourceUrl: '',
	pdfUrl: '',
	pdfTitle: '',
	pdfPage: '',
	sections: emptySections(),
	unmappedValues: '',
	rawValues: '',
});

export const setupFormFromSnapshot = (
	setup: SetupSnapshot,
): SetupFormModel => ({
	...emptySetupForm(),
	name: setup.name,
	recordedAt: setup.context?.recordedAt?.slice(0, 10) ?? '',
	track: setup.context?.track ?? '',
	event: setup.context?.event ?? '',
	surface: setup.context?.surface ?? '',
	traction: setup.context?.traction ?? '',
	moisture: setup.context?.moisture ?? '',
	condition: setup.context?.condition ?? '',
	temperature: setup.context?.temperature ?? '',
	sourceUrl: setup.source?.url ?? '',
	pdfUrl: setup.source?.pdfUrl ?? '',
	pdfTitle: setup.source?.pdfTitle ?? '',
	pdfPage: setup.source?.pdfPage == null ? '' : String(setup.source.pdfPage),
	sections: editableSections(setup.sections),
	unmappedValues: setup.unmappedValues
		? JSON.stringify(setup.unmappedValues, null, 2)
		: '',
	rawValues: setup.rawValues ? JSON.stringify(setup.rawValues, null, 2) : '',
});

export const setupFormFromImport = (
	preview: SoDialedImportPreview,
	url: string,
): SetupFormModel => ({
	...emptySetupForm(),
	name:
		preview.source.title?.trim() ||
		[preview.carIdentity.make, preview.carIdentity.model]
			.filter(Boolean)
			.join(' ') ||
		'Imported setup',
	recordedAt: preview.context.recordedAt?.slice(0, 10) ?? '',
	track: preview.context.track ?? '',
	event: preview.context.event ?? '',
	surface: preview.context.surface ?? '',
	traction: preview.context.traction ?? '',
	moisture: preview.context.moisture ?? '',
	condition: preview.context.condition ?? '',
	temperature: preview.context.temperature ?? '',
	sourceUrl: preview.source.url ?? url,
	pdfUrl: preview.source.pdfUrl ?? '',
	pdfTitle: preview.source.pdfTitle ?? preview.source.title ?? '',
	pdfPage: preview.source.pdfPage == null ? '' : String(preview.source.pdfPage),
	sections: editableSections(preview.sections),
	unmappedValues: JSON.stringify(
		{ uncertain: preview.uncertainValues, unmapped: preview.unmappedValues },
		null,
		2,
	),
	rawValues: JSON.stringify(preview.rawValues, null, 2),
});

const optionalRecord = (values: Record<string, string>) =>
	Object.fromEntries(
		Object.entries(values)
			.map(([key, value]) => [key, value?.trim() ?? ''])
			.filter(([, value]) => value),
	);

export const parseSetupJsonObject = (
	value: string,
): Record<string, unknown> => {
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return value.trim() ? { raw: value.trim() } : {};
	}
};

export const setupDraftFromForm = (
	form: SetupFormModel,
): SetupSnapshotDraft => {
	const unmappedValues = parseSetupJsonObject(form.unmappedValues);
	const rawValues = parseSetupJsonObject(form.rawValues);
	return {
		name: form.name.trim(),
		setupDate: form.recordedAt
			? new Date(`${form.recordedAt}T00:00:00.000Z`).toISOString()
			: null,
		track: form.track.trim() || null,
		event: form.event.trim() || null,
		surface: form.surface.trim() || null,
		traction: form.traction.trim() || null,
		moisture: form.moisture.trim() || null,
		condition: form.condition.trim() || null,
		temperature: form.temperature.trim() || null,
		vehicle: optionalRecord(form.sections.vehicle),
		drivetrain: optionalRecord(form.sections.drivetrain),
		electronics: optionalRecord(form.sections.electronics),
		tires: optionalRecord(form.sections.tires),
		shocks: optionalRecord(form.sections.shocks),
		frontSuspension: optionalRecord(form.sections.frontSuspension),
		rearSuspension: optionalRecord(form.sections.rearSuspension),
		notes: optionalRecord(form.sections.notes)['setupNotes'] ?? null,
		sourceUrl: form.sourceUrl.trim() || null,
		sourcePdfReference: form.pdfTitle.trim() || null,
		sourceMetadata: {
			pdfUrl: form.pdfUrl.trim() || null,
			pdfPage: form.pdfPage.trim() ? Number(form.pdfPage) : null,
		},
		unmappedValues: Object.keys(unmappedValues).length ? unmappedValues : null,
		rawValues: Object.keys(rawValues).length ? rawValues : null,
	};
};

export const importKnownValues = (draft: SetupSnapshotDraft) => ({
	...draft,
	makeCurrent: undefined,
});

export type SetupEditorRequest = {
	readonly sourceCarId: string;
	readonly targetCarId: string;
	readonly mode: 'add' | 'edit';
	readonly setupId: string | null;
	readonly importPreview: SoDialedImportPreview | null;
};

export const setupSaveCommand = (
	form: SetupFormModel,
	request: SetupEditorRequest,
): Extract<SetupWorkflowCommand, { kind: 'save' }> => {
	const snapshot = setupDraftFromForm(form);
	const importPreview = request.importPreview;
	const reviewValues = parseSetupJsonObject(form.unmappedValues);
	return {
		kind: 'save',
		sourceCarId: request.sourceCarId,
		targetCarId: request.targetCarId,
		mode: request.mode,
		setupId: request.setupId,
		snapshot,
		importDraft: importPreview
			? {
					draftId: importPreview.draftId,
					name: form.name.trim(),
					review: {
						carId: request.targetCarId,
						knownValues: importKnownValues(snapshot),
						uncertainValues:
							(reviewValues['uncertain'] as
								| Record<string, unknown>
								| undefined) ?? importPreview.uncertainValues,
						rawValues: parseSetupJsonObject(form.rawValues),
						unmappedValues:
							(reviewValues['unmapped'] as
								| Record<string, unknown>
								| undefined) ?? {},
						sourceMetadata: { ...snapshot.sourceMetadata },
					},
				}
			: null,
	};
};
