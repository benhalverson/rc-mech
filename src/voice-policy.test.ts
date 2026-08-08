import { describe, expect, test } from 'vitest';
import {
	voiceConsumable,
	voiceContextUpdateInput,
	voiceDraftInput,
	voiceTextCaptureInput,
} from './types';
import {
	validateVoiceMetadata,
	VOICE_MAX_BYTES,
	voiceObjectKey,
} from './voice-policy';

describe('voice policy', () => {
	test.each([
		['audio/webm', 12],
		['audio/webm;codecs=opus', 12],
		['audio/mp4', 12],
		['audio/mpeg', 12],
		['audio/ogg', 12],
		['audio/ogg; codecs=opus', 12],
		['audio/wav', 12],
	] as const)('accepts %s audio metadata', (contentType, byteSize) => {
		expect(validateVoiceMetadata({ contentType, byteSize })).toBeUndefined();
	});

	test.each([
		['text/plain', 12, 'Use a WebM'],
		['audio/webm', 0, 'empty'],
		['audio/webm', 1.5, 'empty'],
		['audio/webm', VOICE_MAX_BYTES + 1, '15 MB'],
	] as const)(
		'rejects invalid voice metadata',
		(contentType, byteSize, message) => {
			expect(validateVoiceMetadata({ contentType, byteSize })).toContain(
				message,
			);
		},
	);

	test('builds an owner and car partitioned object key', () => {
		expect(voiceObjectKey('owner-1', 'car-1', 'capture-1')).toBe(
			'voice/owner-1/car-1/capture-1',
		);
	});

	test.each([
		{
			kind: 'tires',
			confidence: 'high',
			needsReview: false,
			sourceText: 'changed tires',
		},
		{
			kind: 'fluid',
			confidence: 'high',
			needsReview: false,
			sourceText: 'changed oil',
		},
		{
			kind: 'fluid',
			fluidArea: 'custom',
			confidence: 'high',
			needsReview: false,
			sourceText: 'changed oil',
		},
	] as const)('rejects incomplete extracted consumables', (value) => {
		expect(voiceConsumable.safeParse(value).success).toBe(false);
	});

	test('accepts a complete empty review draft and validates capture mutations', () => {
		expect(
			voiceDraftInput.safeParse({
				setupChanges: [],
				problems: [],
				conditions: [],
				driveSessionNotes: [],
				consumables: [],
				unmappedNotes: [],
				unresolvedNotes: [],
			}).success,
		).toBe(true);
		expect(
			voiceTextCaptureInput.safeParse({
				captureId: '35ecb4da-0bb4-46cc-85d6-b02c7b3d9552',
				text: 'Car pushed at corner exit',
			}).success,
		).toBe(true);
		expect(voiceContextUpdateInput.safeParse({}).success).toBe(false);
	});
});
