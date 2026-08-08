import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { driveSession, voiceUpdate, voiceUpdateResult } from '../../schema';
import { type AppContext, voiceDraftInput } from '../../types';
import { jsonValue } from '../json-values';

export type VoiceCorrectionRecord = {
	id: string;
	kind: 'voice' | 'text' | 'manual';
	transcript: string;
	objectKey?: string;
	contentType?: string;
	byteSize?: number;
	createdAt: string;
};

export const correctionRecords = (
	value: string | null,
): VoiceCorrectionRecord[] => {
	const parsed = jsonValue(value);
	if (!Array.isArray(parsed)) return [];
	return parsed.filter((item): item is VoiceCorrectionRecord => {
		if (!item || typeof item !== 'object') return false;
		const record = item as Partial<VoiceCorrectionRecord>;
		return (
			typeof record.id === 'string' &&
			(record.kind === 'voice' ||
				record.kind === 'text' ||
				record.kind === 'manual') &&
			typeof record.transcript === 'string' &&
			typeof record.createdAt === 'string'
		);
	});
};

const resultUrl = (
	carId: string,
	value: typeof voiceUpdateResult.$inferSelect,
): string => {
	switch (value.kind) {
		case 'setup':
			return `/garage/${encodeURIComponent(carId)}/setups`;
		case 'drive-session':
			return `/garage/${encodeURIComponent(carId)}/runs`;
		case 'consumable':
			return '/maintenance';
		default:
			return `/garage/${encodeURIComponent(carId)}/runs`;
	}
};

export const publicVoiceResult = (
	carId: string,
	value: typeof voiceUpdateResult.$inferSelect,
) => ({
	id: value.id,
	kind: value.kind,
	recordId: value.recordId,
	label: value.label,
	url: resultUrl(carId, value),
	createdAt: value.createdAt,
});

export const publicVoiceUpdate = (
	value: typeof voiceUpdate.$inferSelect,
	results: Array<typeof voiceUpdateResult.$inferSelect> = [],
) => {
	const parsedDraft = voiceDraftInput.safeParse(jsonValue(value.draftJson));
	const corrections = correctionRecords(value.correctionsJson);
	return {
		id: value.id,
		carId: value.carId,
		driveSessionId: value.driveSessionId,
		status: value.status,
		contentType: value.contentType,
		fileName: value.fileName,
		byteSize: value.byteSize,
		audioUrl:
			value.objectKey && !value.artifactDeletedAt
				? `/api/v1/voice-updates/${value.id}/audio`
				: null,
		transcript: value.transcript,
		draft: parsedDraft.success ? parsedDraft.data : null,
		corrections: corrections.map(
			({ objectKey: _objectKey, ...correction }) => ({
				...correction,
				audioUrl: _objectKey
					? `/api/v1/voice-updates/${value.id}/corrections/${correction.id}/audio`
					: null,
			}),
		),
		clarificationPrompt: value.clarificationPrompt,
		error: value.error,
		confirmedAt: value.confirmedAt,
		artifactDeletedAt: value.artifactDeletedAt,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		results: results.map((result) => publicVoiceResult(value.carId, result)),
	};
};

export const ownedVoiceUpdate = async (c: AppContext, voiceUpdateId: string) =>
	db(c.env)
		.select()
		.from(voiceUpdate)
		.where(
			and(
				eq(voiceUpdate.id, voiceUpdateId),
				eq(voiceUpdate.ownerId, c.get('userId')),
			),
		)
		.get();

export const voiceResults = async (c: AppContext, voiceUpdateId: string) =>
	db(c.env)
		.select()
		.from(voiceUpdateResult)
		.where(eq(voiceUpdateResult.voiceUpdateId, voiceUpdateId));

export const ownedDriveSession = async (
	c: AppContext,
	carId: string,
	driveSessionId: string,
) =>
	db(c.env)
		.select()
		.from(driveSession)
		.where(
			and(eq(driveSession.id, driveSessionId), eq(driveSession.carId, carId)),
		)
		.get();
