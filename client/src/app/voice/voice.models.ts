export type VoiceStatus =
	| 'pending'
	| 'processing'
	| 'needs-review'
	| 'saved'
	| 'failed'
	| 'discarded';

export type LocalVoiceStatus = 'local' | 'queued' | 'failed';
export type VoiceConfidence = 'high' | 'medium' | 'low';

type VoiceFact = {
	confidence: VoiceConfidence;
	needsReview: boolean;
	sourceText: string;
};

export type VoiceSetupChange = VoiceFact & {
	section:
		| 'context'
		| 'vehicle'
		| 'drivetrain'
		| 'electronics'
		| 'tires'
		| 'shocks'
		| 'frontSuspension'
		| 'rearSuspension';
	field: string;
	value: string | number | boolean;
};

export type VoiceObservation = VoiceFact & { text: string };
export type VoiceCondition = VoiceFact & {
	field:
		| 'track'
		| 'event'
		| 'surface'
		| 'traction'
		| 'moisture'
		| 'condition'
		| 'temperature';
	value: string;
};
export type VoiceConsumable = VoiceFact & {
	kind: 'tires' | 'fluid';
	axle?: 'front' | 'rear' | 'both';
	details?: string;
	fluidArea?:
		| 'front-shocks'
		| 'rear-shocks'
		| 'front-differential'
		| 'rear-differential'
		| 'custom';
	customFluidArea?: string;
	notes?: string;
};

export type VoiceDraft = {
	setupChanges: VoiceSetupChange[];
	problems: VoiceObservation[];
	conditions: VoiceCondition[];
	driveSessionNotes: VoiceObservation[];
	consumables: VoiceConsumable[];
	unmappedNotes: string[];
	unresolvedNotes: string[];
};

export type VoiceCorrection = {
	id: string;
	kind: 'voice' | 'text' | 'manual';
	transcript: string;
	contentType?: string;
	byteSize?: number;
	audioUrl: string | null;
	createdAt: string;
};

export type VoiceResult = {
	id: string;
	kind: 'setup' | 'drive-session' | 'problem-note' | 'consumable';
	recordId: string;
	label: string;
	url: string;
	createdAt: string;
};

export type VoiceUpdate = {
	id: string;
	carId: string;
	driveSessionId: string | null;
	status: VoiceStatus;
	contentType: string | null;
	fileName: string | null;
	byteSize: number;
	audioUrl: string | null;
	transcript: string | null;
	draft: VoiceDraft | null;
	corrections: VoiceCorrection[];
	clarificationPrompt: string | null;
	error: string | null;
	confirmedAt: string | null;
	artifactDeletedAt: string | null;
	createdAt: string;
	updatedAt: string;
	results: VoiceResult[];
};

export type PendingVoiceCapture = {
	id: string;
	ownerKey: string;
	carId: string;
	driveSessionId: string | null;
	blob?: Blob;
	text?: string;
	contentType: string;
	fileName: string;
	createdAt: string;
	status: LocalVoiceStatus;
	error: string | null;
};

export type VoiceListResponse = { voiceUpdates: VoiceUpdate[] };
export type VoiceCorrectionOutcome = 'ai-draft' | 'manual-note';
export type VoiceMutationResponse = {
	voiceUpdate: VoiceUpdate;
	correction?: { outcome: VoiceCorrectionOutcome };
};
