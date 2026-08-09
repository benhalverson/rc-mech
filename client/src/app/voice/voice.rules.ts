import type { VoiceConfidence, VoiceUpdate } from './voice.models';

export const voiceUpdateHasUncertainty = (update: VoiceUpdate): boolean => {
	const draft = update.draft;
	return Boolean(
		draft &&
			(draft.unresolvedNotes.length ||
				draft.setupChanges.some((item) => item.needsReview) ||
				draft.problems.some((item) => item.needsReview) ||
				draft.conditions.some((item) => item.needsReview) ||
				draft.driveSessionNotes.some((item) => item.needsReview) ||
				draft.consumables.some((item) => item.needsReview)),
	);
};

export const voiceConfidenceLabel = (
	confidence: VoiceConfidence,
	needsReview: boolean,
): string =>
	needsReview
		? `${confidence} confidence · review`
		: `${confidence} confidence`;

export const voiceRecordingDuration = (
	totalSeconds: number,
): {
	readonly clock: string;
	readonly datetime: string;
	readonly label: string;
} => {
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return {
		clock: `${minutes}:${seconds.toString().padStart(2, '0')}`,
		datetime: `PT${totalSeconds}S`,
		label: `Elapsed recording time: ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}, ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`,
	};
};
