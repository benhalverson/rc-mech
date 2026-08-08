import { describe, expect, test, vi } from 'vitest';
import { defaultAppDependencies } from './app-dependencies';
import { createHonoFixture } from './testing/hono-fixture';
import {
	createWorkersAiVoiceProcessor,
	type VoiceProcessingRequest,
	VoiceProcessingError,
} from './voice-processing';

const emptyDraft = {
	setupChanges: [],
	problems: [],
	conditions: [],
	driveSessionNotes: [],
	consumables: [],
	unmappedNotes: [],
	unresolvedNotes: [],
};

const request = (
	overrides: Partial<VoiceProcessingRequest> = {},
): VoiceProcessingRequest => ({
	text: 'The car pushed on corner exit',
	context: { carName: 'Buggy' },
	...overrides,
});

describe('Workers AI voice processor', () => {
	test('extracts a text fallback with JSON object mode and runtime validation', async () => {
		const { env } = createHonoFixture();
		const run = vi.spyOn(env.AI, 'run');
		const calls = run.mock.calls as unknown as [unknown, unknown?][];
		run.mockResolvedValueOnce({
			response: JSON.stringify({
				draft: emptyDraft,
				clarificationPrompt: null,
			}),
		} as never);

		await expect(
			createWorkersAiVoiceProcessor(env).process(request()),
		).resolves.toEqual({
			transcript: 'The car pushed on corner exit',
			draft: emptyDraft,
			clarificationPrompt: null,
		});
		expect(run).toHaveBeenCalledOnce();
		expect(calls[0]?.[0]).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
		expect(calls[0]?.[1]).toMatchObject({
			response_format: { type: 'json_object' },
		});
	});

	test.each([
		"5024: JSON Model couldn't be met",
		"5024: JSON Mode couldn't be met",
	])('falls back to prompted JSON after %s', async (providerError) => {
		const { env } = createHonoFixture();
		const run = vi.spyOn(env.AI, 'run');
		const calls = run.mock.calls as unknown as [unknown, unknown?][];
		run.mockRejectedValueOnce(new Error(providerError));
		run.mockResolvedValueOnce({
			response: JSON.stringify({
				draft: emptyDraft,
				clarificationPrompt: null,
			}),
		} as never);

		await expect(
			createWorkersAiVoiceProcessor(env).process(request()),
		).resolves.toMatchObject({
			transcript: 'The car pushed on corner exit',
			draft: emptyDraft,
		});
		expect(run).toHaveBeenCalledTimes(2);
		expect(calls[0]?.[1]).toMatchObject({
			response_format: { type: 'json_object' },
		});
		expect(calls[1]?.[1]).not.toHaveProperty('response_format');
		expect(JSON.stringify(calls[0]?.[1])).toContain('clarificationPrompt');
	});

	test('does not retry unrelated provider failures', async () => {
		const { env } = createHonoFixture();
		const run = vi
			.spyOn(env.AI, 'run')
			.mockRejectedValueOnce(new Error('Network connection lost'));

		await expect(
			createWorkersAiVoiceProcessor(env).process(request()),
		).rejects.toThrow('Network connection lost');
		expect(run).toHaveBeenCalledOnce();
	});

	test('normalizes non-Error provider failures safely', async () => {
		const { env } = createHonoFixture();
		vi.spyOn(env.AI, 'run').mockRejectedValueOnce('provider failed');
		await expect(
			createWorkersAiVoiceProcessor(env).process(request()),
		).rejects.toMatchObject({ stage: 'extraction', attemptCount: 1 });
		expect(
			new VoiceProcessingError('invalid cause', 'validation', 1, {
				cause: 'provider failed',
			}).name,
		).toBe('Error');
	});

	test('retries a transcription upstream failure once', async () => {
		const { env } = createHonoFixture();
		const run = vi.spyOn(env.AI, 'run');
		const upstream = Object.assign(new Error('temporary upstream'), {
			name: 'InferenceUpstreamError',
		});
		run.mockRejectedValueOnce(upstream);
		run.mockResolvedValueOnce({ text: 'Changed rear tires' } as never);
		run.mockResolvedValueOnce({
			response: JSON.stringify({
				draft: emptyDraft,
				clarificationPrompt: null,
			}),
		} as never);

		await expect(
			createWorkersAiVoiceProcessor(env).process(
				request({
					text: undefined,
					audio: new ArrayBuffer(1),
					contentType: 'audio/webm',
				}),
			),
		).resolves.toMatchObject({ transcript: 'Changed rear tires' });
		expect(run).toHaveBeenCalledTimes(3);
	});

	test('exhausts an upstream retry after two attempts', async () => {
		const { env } = createHonoFixture();
		const run = vi.spyOn(env.AI, 'run');
		const upstream = Object.assign(new Error('temporary upstream'), {
			name: 'InferenceUpstreamError',
		});
		run.mockRejectedValue(upstream);

		await expect(
			createWorkersAiVoiceProcessor(env).process(
				request({
					text: undefined,
					audio: new ArrayBuffer(1),
					contentType: 'audio/webm',
				}),
			),
		).rejects.toMatchObject({
			name: 'InferenceUpstreamError',
			stage: 'transcription',
			attemptCount: 2,
		});
		expect(run).toHaveBeenCalledTimes(2);
	});

	test('retries an extraction upstream failure once', async () => {
		const { env } = createHonoFixture();
		const run = vi.spyOn(env.AI, 'run');
		const upstream = Object.assign(new Error('temporary upstream'), {
			name: 'InferenceUpstreamError',
		});
		run.mockRejectedValueOnce(upstream);
		run.mockResolvedValueOnce({
			response: JSON.stringify({
				draft: emptyDraft,
				clarificationPrompt: null,
			}),
		} as never);

		await expect(
			createWorkersAiVoiceProcessor(env).process(request()),
		).resolves.toMatchObject({ draft: emptyDraft });
		expect(run).toHaveBeenCalledTimes(2);
	});

	test('accepts a JSON object wrapped in a provider Markdown fence', async () => {
		const { env } = createHonoFixture();
		vi.spyOn(env.AI, 'run').mockResolvedValueOnce({
			response: `\`\`\`json
${JSON.stringify({ draft: emptyDraft, clarificationPrompt: null })}
\`\`\``,
		} as never);

		await expect(
			createWorkersAiVoiceProcessor(env).process(request()),
		).resolves.toMatchObject({
			draft: emptyDraft,
			clarificationPrompt: null,
		});
	});

	test('transcribes audio before extracting the draft', async () => {
		const { env } = createHonoFixture();
		const run = vi.spyOn(env.AI, 'run');
		const calls = run.mock.calls as unknown as [unknown, unknown?][];
		run.mockResolvedValueOnce({ text: 'Changed rear tires' } as never);
		run.mockResolvedValueOnce(
			JSON.stringify({
				draft: emptyDraft,
				clarificationPrompt: 'Which axle?',
			}) as never,
		);

		await expect(
			createWorkersAiVoiceProcessor(env).process(
				request({
					text: undefined,
					audio: await new Blob(['audio']).arrayBuffer(),
					contentType: 'audio/webm',
				}),
			),
		).resolves.toMatchObject({
			transcript: 'Changed rear tires',
			clarificationPrompt: 'Which axle?',
		});
		expect(run).toHaveBeenCalledTimes(2);
		expect(calls[0]?.[0]).toBe('@cf/openai/whisper-large-v3-turbo');
	});

	test('includes the existing draft when extracting a correction', async () => {
		const { env } = createHonoFixture();
		const run = vi.spyOn(env.AI, 'run');
		const calls = run.mock.calls as unknown as [unknown, unknown?][];
		run.mockResolvedValueOnce({
			response: JSON.stringify({ draft: emptyDraft }),
		} as never);

		const result = await createWorkersAiVoiceProcessor(env).process(
			request({
				text: 'Rear diff, not front',
				previous: { transcript: 'Changed front diff', draft: emptyDraft },
			}),
		);
		expect(result.clarificationPrompt).toBeNull();
		expect(JSON.stringify(calls[0]?.[1])).toContain('Rear diff, not front');
	});

	test.each([
		request({ text: undefined }),
		request({
			text: undefined,
			audio: new ArrayBuffer(0),
			contentType: undefined,
		}),
	] as const)('requires a usable recording or text note', async (input) => {
		const { env } = createHonoFixture();
		await expect(
			createWorkersAiVoiceProcessor(env).process(input),
		).rejects.toThrow('recording or text');
	});

	test('rejects an empty transcription', async () => {
		const { env } = createHonoFixture();
		vi.spyOn(env.AI, 'run').mockResolvedValueOnce({ text: ' ' } as never);
		await expect(
			createWorkersAiVoiceProcessor(env).process(
				request({
					text: undefined,
					audio: new ArrayBuffer(1),
					contentType: 'audio/webm',
				}),
			),
		).rejects.toThrow('No speech');
	});

	test.each([{} as never, { response: 42 } as never])(
		'rejects a provider response without generated text',
		async (output) => {
			const { env } = createHonoFixture();
			vi.spyOn(env.AI, 'run').mockResolvedValueOnce(output);
			await expect(
				createWorkersAiVoiceProcessor(env).process(request()),
			).rejects.toThrow('no response');
		},
	);

	test('rejects malformed provider JSON and exposes the default factory', async () => {
		const { env } = createHonoFixture();
		vi.spyOn(env.AI, 'run').mockResolvedValueOnce({ response: '{}' } as never);
		await expect(
			defaultAppDependencies.voiceProcessor(env).process(request()),
		).rejects.toThrow();
	});
});
