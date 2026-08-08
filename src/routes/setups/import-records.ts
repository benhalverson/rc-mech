import { setupImportDraft } from '../../schema';
import type { SetupImportExtraction } from '../../setup-import-policy';
import { type SetupInput, setupInput } from '../../types';
import { jsonText, jsonValue } from '../json-values';

export const publicImportDraft = (
	value: typeof setupImportDraft.$inferSelect,
) => ({
	id: value.id,
	carId: value.carId,
	sourceUrl: value.sourceUrl,
	status: value.status,
	sourceIdentity: jsonValue(value.sourceIdentity),
	source: {
		url: value.sourceUrl,
		hasPdfReference: value.sourcePdfReference !== null,
		metadata: jsonValue(value.sourceMetadata),
	},
	knownValues: jsonValue(value.knownValues) ?? {},
	uncertainValues: jsonValue(value.uncertainValues) ?? {},
	rawValues: jsonValue(value.rawValues) ?? {},
	unmappedValues: jsonValue(value.unmappedValues) ?? {},
	error: value.error,
	acceptedSetupId: value.acceptedSetupId,
	createdAt: value.createdAt,
	updatedAt: value.updatedAt,
});

export const draftValues = (value: SetupImportExtraction) => ({
	sourceIdentity: jsonText(value.sourceIdentity) ?? null,
	sourcePdfReference: value.sourcePdfReference ?? null,
	sourceMetadata: jsonText(value.sourceMetadata) ?? null,
	knownValues: JSON.stringify(value.knownValues),
	uncertainValues: JSON.stringify(value.uncertainValues),
	rawValues: JSON.stringify(value.rawValues),
	unmappedValues: JSON.stringify(value.unmappedValues),
});

export const isUniqueConstraintError = (error: unknown): boolean => {
	let current = error;
	for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
		if (current.message.includes('UNIQUE')) return true;
		current = current.cause;
	}
	return false;
};

export const draftSetupInput = (
	draft: typeof setupImportDraft.$inferSelect,
	name?: string,
): SetupInput => {
	const known = jsonValue(draft.knownValues);
	const raw = jsonValue(draft.rawValues);
	const uncertain = jsonValue(draft.uncertainValues);
	const unmapped = jsonValue(draft.unmappedValues);
	const identity = jsonValue(draft.sourceIdentity);
	const candidate = {
		...(known && typeof known === 'object' ? known : {}),
		name:
			name ??
			(identity && typeof identity === 'object' && 'title' in identity
				? String(identity.title)
				: 'Imported setup'),
		status: 'reviewed' as const,
		sourceUrl: draft.sourceUrl,
		sourcePdfReference: draft.sourcePdfReference ?? undefined,
		sourceMetadata:
			(jsonValue(draft.sourceMetadata) as Record<string, unknown> | null) ??
			undefined,
		rawValues: {
			...(raw && typeof raw === 'object' ? raw : {}),
			uncertainValues: uncertain ?? {},
		},
		unmappedValues:
			unmapped && typeof unmapped === 'object'
				? (unmapped as Record<string, unknown>)
				: {},
	};
	const parsed = setupInput.safeParse(candidate);
	if (parsed.success) return parsed.data;
	return {
		name: candidate.name,
		status: 'reviewed',
		sourceUrl: draft.sourceUrl,
		sourcePdfReference: draft.sourcePdfReference ?? undefined,
		sourceMetadata:
			(jsonValue(draft.sourceMetadata) as Record<string, unknown> | null) ??
			undefined,
		rawValues: candidate.rawValues as Record<string, unknown>,
		unmappedValues: candidate.unmappedValues as Record<string, unknown>,
	};
};
