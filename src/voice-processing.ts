import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { type VoiceDraft, voiceDraftInput } from './types';

export type VoiceProcessingContext = {
	carName: string;
	driveSessionId?: string;
	currentSetupName?: string;
	currentTrack?: string;
};

export type VoiceProcessingRequest = {
	audio?: ArrayBuffer;
	contentType?: string;
	text?: string;
	context: VoiceProcessingContext;
	previous?: {
		transcript: string;
		draft: VoiceDraft;
	};
};

export type VoiceProcessingResult = {
	transcript: string;
	draft: VoiceDraft;
	clarificationPrompt: string | null;
};

export type VoiceProcessor = {
	process(request: VoiceProcessingRequest): Promise<VoiceProcessingResult>;
};

const extractionResult = z.object({
	draft: voiceDraftInput,
	clarificationPrompt: z
		.string()
		.trim()
		.min(1)
		.max(1000)
		.nullable()
		.default(null),
});

const extractionJsonSchema = {
	type: 'object',
	additionalProperties: false,
	required: ['draft', 'clarificationPrompt'],
	properties: {
		draft: {
			type: 'object',
			additionalProperties: false,
			required: [
				'setupChanges',
				'problems',
				'conditions',
				'driveSessionNotes',
				'consumables',
				'unmappedNotes',
				'unresolvedNotes',
			],
			properties: {
				setupChanges: { type: 'array', items: { $ref: '#/$defs/setup' } },
				problems: { type: 'array', items: { $ref: '#/$defs/observation' } },
				conditions: { type: 'array', items: { $ref: '#/$defs/condition' } },
				driveSessionNotes: {
					type: 'array',
					items: { $ref: '#/$defs/observation' },
				},
				consumables: { type: 'array', items: { $ref: '#/$defs/consumable' } },
				unmappedNotes: { type: 'array', items: { type: 'string' } },
				unresolvedNotes: { type: 'array', items: { type: 'string' } },
			},
		},
		clarificationPrompt: { type: ['string', 'null'] },
	},
	$defs: {
		fact: {
			type: 'object',
			properties: {
				confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
				needsReview: { type: 'boolean' },
				sourceText: { type: 'string' },
			},
			required: ['confidence', 'needsReview', 'sourceText'],
		},
		setup: {
			type: 'object',
			additionalProperties: false,
			required: [
				'section',
				'field',
				'value',
				'confidence',
				'needsReview',
				'sourceText',
			],
			properties: {
				section: {
					type: 'string',
					enum: [
						'context',
						'vehicle',
						'drivetrain',
						'electronics',
						'tires',
						'shocks',
						'frontSuspension',
						'rearSuspension',
					],
				},
				field: { type: 'string' },
				value: { type: ['string', 'number', 'boolean'] },
				confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
				needsReview: { type: 'boolean' },
				sourceText: { type: 'string' },
			},
		},
		observation: {
			type: 'object',
			additionalProperties: false,
			required: ['text', 'confidence', 'needsReview', 'sourceText'],
			properties: {
				text: { type: 'string' },
				confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
				needsReview: { type: 'boolean' },
				sourceText: { type: 'string' },
			},
		},
		condition: {
			type: 'object',
			additionalProperties: false,
			required: ['field', 'value', 'confidence', 'needsReview', 'sourceText'],
			properties: {
				field: {
					type: 'string',
					enum: [
						'track',
						'event',
						'surface',
						'traction',
						'moisture',
						'condition',
						'temperature',
					],
				},
				value: { type: 'string' },
				confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
				needsReview: { type: 'boolean' },
				sourceText: { type: 'string' },
			},
		},
		consumable: {
			type: 'object',
			additionalProperties: false,
			required: ['kind', 'confidence', 'needsReview', 'sourceText'],
			properties: {
				kind: { type: 'string', enum: ['tires', 'fluid'] },
				axle: { type: 'string', enum: ['front', 'rear', 'both'] },
				details: { type: 'string' },
				fluidArea: {
					type: 'string',
					enum: [
						'front-shocks',
						'rear-shocks',
						'front-differential',
						'rear-differential',
						'custom',
					],
				},
				customFluidArea: { type: 'string' },
				notes: { type: 'string' },
				confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
				needsReview: { type: 'boolean' },
				sourceText: { type: 'string' },
			},
		},
	},
} as const;

const extractionInstructions = `Convert an RC car track-side voice note into a review draft.
Never invent a number, axle, direction, setup section, car, or track. Mark uncertain facts needsReview=true and use low or medium confidence. Keep every unmatched observation in unmappedNotes. Use context setup fields only for track, event, surface, traction, moisture, condition, and temperature. Use setupChanges for actual car setup deltas. Use problems for symptoms or handling problems. Use driveSessionNotes for run observations. Use consumables only for explicitly stated tire-set or shock/differential-fluid work. If a missing answer blocks safe attribution or a precise change, ask one short clarificationPrompt. Otherwise set clarificationPrompt to null.`;

const extractionOutputInstructions = `${extractionInstructions}
Return only one JSON object matching this JSON Schema: ${JSON.stringify(extractionJsonSchema)}`;

const transcribe = async (
	env: Pick<Env, 'AI'>,
	request: VoiceProcessingRequest,
): Promise<string> => {
	if (request.text) return request.text.trim();
	if (!request.audio || !request.contentType)
		throw new Error('A recording or text note is required');
	const result = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
		audio: Buffer.from(request.audio).toString('base64'),
		task: 'transcribe',
		vad_filter: true,
		condition_on_previous_text: false,
		initial_prompt:
			'RC car setup, handling, tires, shock oil, differential fluid, track conditions, and drive-session notes.',
	});
	const transcript = result.text.trim();
	if (!transcript) throw new Error('No speech was detected in the recording');
	return transcript;
};

const responseText = (value: unknown): string => {
	if (typeof value === 'string') return value;
	if (
		value !== null &&
		typeof value === 'object' &&
		'response' in value &&
		typeof value.response === 'string'
	)
		return value.response;
	throw new Error('The extraction provider returned no response');
};

const responseJson = (value: unknown): unknown => {
	const text = responseText(value).trim();
	const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
	return JSON.parse(fenced?.[1] ?? text);
};

const jsonModeCouldNotBeMet = (error: unknown): boolean =>
	error instanceof Error &&
	/JSON Mo(?:de|del) couldn't be met/.test(error.message);

const extractDraft = async (
	env: Pick<Env, 'AI'>,
	messages: { role: 'system' | 'user'; content: string }[],
): Promise<unknown> => {
	const request = {
		messages,
		temperature: 0,
		max_tokens: 4096,
	};
	const options = { tags: ['rc-mech', 'voice-track-log'] };
	try {
		return await env.AI.run(
			'@cf/meta/llama-3.3-70b-instruct-fp8-fast',
			{ ...request, response_format: { type: 'json_object' } },
			options,
		);
	} catch (error) {
		if (!jsonModeCouldNotBeMet(error)) throw error;
		return env.AI.run(
			'@cf/meta/llama-3.3-70b-instruct-fp8-fast',
			request,
			options,
		);
	}
};

export const createWorkersAiVoiceProcessor = (
	env: Pick<Env, 'AI'>,
): VoiceProcessor => ({
	async process(request) {
		const transcript = await transcribe(env, request);
		const correctionContext = request.previous
			? `This is a correction. Original transcript: ${request.previous.transcript}\nCurrent draft: ${JSON.stringify(request.previous.draft)}\nCorrection: ${transcript}`
			: `Voice note: ${transcript}`;
		const result = await extractDraft(env, [
			{ role: 'system', content: extractionOutputInstructions },
			{
				role: 'user',
				content: `Context: ${JSON.stringify(request.context)}\n${correctionContext}`,
			},
		]);
		const parsed = extractionResult.parse(responseJson(result));
		return {
			transcript,
			draft: parsed.draft,
			clarificationPrompt: parsed.clarificationPrompt,
		};
	},
});
