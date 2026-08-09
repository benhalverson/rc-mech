import { describe, expect, it } from 'vitest';
import type { VoiceDraft, VoiceUpdate } from './voice.models';
import {
	voiceConfidenceLabel,
	voiceRecordingDuration,
	voiceUpdateHasUncertainty,
} from './voice.rules';

const emptyDraft = (): VoiceDraft => ({
	setupChanges: [],
	problems: [],
	conditions: [],
	driveSessionNotes: [],
	consumables: [],
	unmappedNotes: [],
	unresolvedNotes: [],
});

const update = (draft: VoiceDraft | null): VoiceUpdate => ({
	id: 'voice-1',
	carId: 'car-1',
	driveSessionId: null,
	status: 'needs-review',
	contentType: null,
	fileName: null,
	byteSize: 0,
	audioUrl: null,
	transcript: null,
	draft,
	corrections: [],
	clarificationPrompt: null,
	error: null,
	confirmedAt: null,
	artifactDeletedAt: null,
	createdAt: 'now',
	updatedAt: 'now',
	results: [],
});

describe('voice rules', () => {
	it('detects each uncertainty source without inventing facts', () => {
		expect(voiceUpdateHasUncertainty(update(null))).toBe(false);
		expect(voiceUpdateHasUncertainty(update(emptyDraft()))).toBe(false);
		const fact = {
			confidence: 'low' as const,
			needsReview: true,
			sourceText: 'x',
		};
		for (const draft of [
			{ ...emptyDraft(), unresolvedNotes: ['unclear'] },
			{
				...emptyDraft(),
				setupChanges: [
					{ ...fact, section: 'vehicle' as const, field: 'x', value: 1 },
				],
			},
			{ ...emptyDraft(), problems: [{ ...fact, text: 'x' }] },
			{
				...emptyDraft(),
				conditions: [{ ...fact, field: 'track' as const, value: 'x' }],
			},
			{ ...emptyDraft(), driveSessionNotes: [{ ...fact, text: 'x' }] },
			{
				...emptyDraft(),
				consumables: [{ ...fact, kind: 'tires' as const }],
			},
		])
			expect(voiceUpdateHasUncertainty(update(draft))).toBe(true);
	});

	it('formats confidence and accessible recording duration', () => {
		expect(voiceConfidenceLabel('low', true)).toBe('low confidence · review');
		expect(voiceConfidenceLabel('high', false)).toBe('high confidence');
		expect(voiceRecordingDuration(0)).toEqual({
			clock: '0:00',
			datetime: 'PT0S',
			label: 'Elapsed recording time: 0 minutes, 0 seconds',
		});
		expect(voiceRecordingDuration(61)).toEqual({
			clock: '1:01',
			datetime: 'PT61S',
			label: 'Elapsed recording time: 1 minute, 1 second',
		});
	});
});
