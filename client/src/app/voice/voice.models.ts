import type * as z from 'zod/mini';
import {
	array,
	boolean,
	literal,
	nullable,
	number,
	object,
	optional,
	string,
	union,
} from 'zod/mini';

const voiceStatusSchema = union([
	literal('pending'),
	literal('processing'),
	literal('needs-review'),
	literal('saved'),
	literal('failed'),
	literal('discarded'),
]);

const confidenceSchema = union([
	literal('high'),
	literal('medium'),
	literal('low'),
]);

const voiceFactSchema = {
	confidence: confidenceSchema,
	needsReview: boolean(),
	sourceText: string(),
};

const setupChangeSchema = object({
	...voiceFactSchema,
	section: union([
		literal('context'),
		literal('vehicle'),
		literal('drivetrain'),
		literal('electronics'),
		literal('tires'),
		literal('shocks'),
		literal('frontSuspension'),
		literal('rearSuspension'),
	]),
	field: string(),
	value: union([string(), number(), boolean()]),
});

const observationSchema = object({ ...voiceFactSchema, text: string() });

const conditionSchema = object({
	...voiceFactSchema,
	field: union([
		literal('track'),
		literal('event'),
		literal('surface'),
		literal('traction'),
		literal('moisture'),
		literal('condition'),
		literal('temperature'),
	]),
	value: string(),
});

const consumableSchema = object({
	...voiceFactSchema,
	kind: union([literal('tires'), literal('fluid')]),
	axle: optional(union([literal('front'), literal('rear'), literal('both')])),
	details: optional(string()),
	fluidArea: optional(
		union([
			literal('front-shocks'),
			literal('rear-shocks'),
			literal('front-differential'),
			literal('rear-differential'),
			literal('custom'),
		]),
	),
	customFluidArea: optional(string()),
	notes: optional(string()),
});

export const voiceDraftSchema = object({
	setupChanges: array(setupChangeSchema),
	problems: array(observationSchema),
	conditions: array(conditionSchema),
	driveSessionNotes: array(observationSchema),
	consumables: array(consumableSchema),
	unmappedNotes: array(string()),
	unresolvedNotes: array(string()),
});

const correctionSchema = object({
	id: string(),
	kind: union([literal('voice'), literal('text'), literal('manual')]),
	transcript: string(),
	contentType: optional(string()),
	byteSize: optional(number()),
	audioUrl: nullable(string()),
	createdAt: string(),
});

const resultSchema = object({
	id: string(),
	kind: union([
		literal('setup'),
		literal('drive-session'),
		literal('problem-note'),
		literal('consumable'),
	]),
	recordId: string(),
	label: string(),
	url: string(),
	createdAt: string(),
});

export const voiceUpdateSchema = object({
	id: string(),
	carId: string(),
	driveSessionId: nullable(string()),
	status: voiceStatusSchema,
	contentType: nullable(string()),
	fileName: nullable(string()),
	byteSize: number(),
	audioUrl: nullable(string()),
	transcript: nullable(string()),
	draft: nullable(voiceDraftSchema),
	corrections: array(correctionSchema),
	clarificationPrompt: nullable(string()),
	error: nullable(string()),
	confirmedAt: nullable(string()),
	artifactDeletedAt: nullable(string()),
	createdAt: string(),
	updatedAt: string(),
	results: array(resultSchema),
});

export const voiceListSchema = object({
	voiceUpdates: array(voiceUpdateSchema),
});

export const voiceMutationSchema = object({
	voiceUpdate: voiceUpdateSchema,
	correction: optional(
		object({
			outcome: union([literal('ai-draft'), literal('manual-note')]),
		}),
	),
});

export const voiceContextCarsSchema = object({
	cars: array(
		object({
			id: string(),
			name: string(),
			archivedAt: nullable(string()),
		}),
	),
});

export type VoiceStatus = z.infer<typeof voiceStatusSchema>;
export type LocalVoiceStatus = 'local' | 'queued' | 'failed';
export type VoiceConfidence = z.infer<typeof confidenceSchema>;
export type VoiceSetupChange = z.infer<typeof setupChangeSchema>;
export type VoiceObservation = z.infer<typeof observationSchema>;
export type VoiceCondition = z.infer<typeof conditionSchema>;
export type VoiceConsumable = z.infer<typeof consumableSchema>;
export type VoiceDraft = z.infer<typeof voiceDraftSchema>;
export type VoiceCorrection = z.infer<typeof correctionSchema>;
export type VoiceResult = z.infer<typeof resultSchema>;
export type VoiceUpdate = z.infer<typeof voiceUpdateSchema>;
export type VoiceListResponse = z.infer<typeof voiceListSchema>;
export type VoiceCorrectionOutcome = 'ai-draft' | 'manual-note';
export type VoiceMutationResponse = z.infer<typeof voiceMutationSchema>;
export type VoiceContextCar = z.infer<
	typeof voiceContextCarsSchema
>['cars'][number];

export type PendingVoiceCapture = {
	readonly id: string;
	readonly ownerKey: string;
	readonly carId: string;
	readonly driveSessionId: string | null;
	readonly blob?: Blob;
	readonly text?: string;
	readonly contentType: string;
	readonly fileName: string;
	readonly createdAt: string;
	readonly status: LocalVoiceStatus;
	readonly error: string | null;
};

export type VoiceRecordingMode =
	| { readonly kind: 'capture' }
	| { readonly kind: 'correction'; readonly id: string };

export type VoiceGatewayFailure =
	| { readonly kind: 'http'; readonly status: number }
	| {
			readonly kind: 'rejected-response';
			readonly status: number;
			readonly message: string;
	  }
	| { readonly kind: 'unavailable' }
	| { readonly kind: 'invalid-response' };

export type VoiceWorkflowFailure =
	| VoiceGatewayFailure
	| { readonly kind: 'invalid-command'; readonly message: string }
	| { readonly kind: 'recording'; readonly message: string }
	| { readonly kind: 'processing'; readonly message: string }
	| { readonly kind: 'local-storage'; readonly message: string };

export type VoiceOperation =
	| 'start-recording'
	| 'capture-audio'
	| 'capture-text'
	| 'retry-queued'
	| 'discard-local'
	| 'process'
	| 'correct-text'
	| 'correct-audio'
	| 'confirm'
	| 'update-context'
	| 'discard-server';

export type VoiceOperationOutcome =
	| {
			readonly status: 'idle';
			readonly operation: null;
			readonly operationId: null;
	  }
	| {
			readonly status: 'pending';
			readonly operation: VoiceOperation;
			readonly operationId: number;
			readonly subjectId: string | null;
	  }
	| {
			readonly status: 'succeeded';
			readonly operation: VoiceOperation;
			readonly operationId: number;
			readonly subjectId: string | null;
			readonly update: VoiceUpdate | null;
			readonly destinationCarId: string | null;
	  }
	| {
			readonly status: 'failed';
			readonly operation: VoiceOperation;
			readonly operationId: number;
			readonly subjectId: string | null;
			readonly error: VoiceWorkflowFailure;
	  };

export type CaptureTextCommand = Readonly<{
	text: string;
	driveSessionId: string | null;
}>;

export type StopRecordingCommand = Readonly<{
	driveSessionId: string | null;
}>;

export type CorrectVoiceTextCommand = Readonly<{
	id: string;
	text: string;
}>;

export type UpdateVoiceContextCommand = Readonly<{
	id: string;
	carId: string;
	driveSessionId: string | null;
}>;
