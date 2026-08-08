import { afterEach, describe, expect, test, vi } from 'vitest';
import {
	createHonoFixture,
	type MockD1Controller,
} from './testing/hono-fixture';
import type { VoiceProcessor } from './voice-processing';
import { VoiceProcessingError } from './voice-processing';

const id = '35ecb4da-0bb4-46cc-85d6-b02c7b3d9552';
const now = '2026-08-08T01:00:00.000Z';
const emptyDraft = {
	setupChanges: [],
	problems: [],
	conditions: [],
	driveSessionNotes: [],
	consumables: [],
	unmappedNotes: [],
	unresolvedNotes: [],
};

const car = (overrides: Record<string, unknown> = {}) => ({
	id: 'car-1',
	ownerId: 'owner-1',
	name: 'Buggy',
	make: null,
	model: null,
	scale: null,
	vehicleType: null,
	powerType: null,
	notes: null,
	currentSetupId: null,
	createdAt: now,
	archivedAt: null,
	...overrides,
});

const setup = (overrides: Record<string, unknown> = {}) => ({
	id: 'setup-1',
	carId: 'car-1',
	name: 'Clay setup',
	status: 'active',
	setupDate: now,
	track: 'Club clay',
	event: null,
	surface: null,
	traction: null,
	moisture: null,
	condition: null,
	temperature: null,
	vehicle: null,
	drivetrain: null,
	electronics: null,
	tires: null,
	shocks: null,
	frontSuspension: null,
	rearSuspension: null,
	notes: null,
	sourceUrl: null,
	sourcePdfReference: null,
	sourceMetadata: null,
	copiedFromId: null,
	rawValues: null,
	unmappedValues: null,
	createdAt: now,
	updatedAt: now,
	...overrides,
});

const voice = (overrides: Record<string, unknown> = {}) => ({
	id,
	ownerId: 'owner-1',
	carId: 'car-1',
	driveSessionId: null,
	objectKey: null,
	contentType: null,
	fileName: null,
	byteSize: 0,
	status: 'pending',
	transcript: 'The car pushed',
	draftJson: null,
	correctionsJson: null,
	clarificationPrompt: null,
	error: null,
	confirmedAt: null,
	artifactDeletedAt: null,
	createdAt: now,
	updatedAt: now,
	...overrides,
});

const processor = (
	implementation: VoiceProcessor['process'] = async () => ({
		transcript: 'The car pushed',
		draft: emptyDraft,
		clarificationPrompt: null,
	}),
): VoiceProcessor => ({ process: vi.fn(implementation) });

const json = (body: unknown): RequestInit => ({
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body),
});

let current: MockD1Controller | undefined;
const fixture = (voiceProcessor = processor()) => {
	const value = createHonoFixture({ voiceProcessor });
	current = value.d1;
	return value;
};

afterEach(() => {
	current?.expectConsumed();
	current = undefined;
	vi.restoreAllMocks();
});

describe('voice processing routes', () => {
	test('processes a text note with current car and setup context', async () => {
		const process = vi.fn<VoiceProcessor['process']>(async () => ({
			transcript: 'The car pushed',
			draft: emptyDraft,
			clarificationPrompt: 'Was that the front or rear?',
		}));
		const { d1, request } = fixture({ process });
		d1.queue(
			{ kind: 'first', value: voice() },
			{ kind: 'first', value: car({ currentSetupId: 'setup-1' }) },
			{ kind: 'first', value: setup() },
			{ kind: 'run' },
			{ kind: 'run' },
			{
				kind: 'first',
				value: voice({
					status: 'needs-review',
					draftJson: JSON.stringify(emptyDraft),
					clarificationPrompt: 'Was that the front or rear?',
				}),
			},
		);
		const response = await request(`/api/v1/voice-updates/${id}/process`, {
			method: 'POST',
		});
		expect(response.status).toBe(200);
		expect(process).toHaveBeenCalledWith(
			expect.objectContaining({
				text: 'The car pushed',
				context: expect.objectContaining({
					currentSetupName: 'Clay setup',
					currentTrack: 'Club clay',
				}),
			}),
		);
	});

	test('loads private audio for deterministic processing', async () => {
		const process = vi.fn<VoiceProcessor['process']>(async () => ({
			transcript: 'Changed tires',
			draft: emptyDraft,
			clarificationPrompt: null,
		}));
		const { d1, r2, request } = fixture({ process });
		r2.seed('voice-key', 'audio', { contentType: 'audio/webm' });
		d1.queue(
			{
				kind: 'first',
				value: voice({
					objectKey: 'voice-key',
					contentType: 'audio/webm',
					fileName: 'note.webm',
					byteSize: 5,
					transcript: null,
				}),
			},
			{ kind: 'first', value: car() },
			{ kind: 'run' },
			{ kind: 'run' },
			{
				kind: 'first',
				value: voice({
					status: 'needs-review',
					draftJson: JSON.stringify(emptyDraft),
					transcript: 'Changed tires',
				}),
			},
		);
		expect(
			(
				await request(`/api/v1/voice-updates/${id}/process`, {
					method: 'POST',
				})
			).status,
		).toBe(200);
		expect(process.mock.calls[0]?.[0].audio).toBeInstanceOf(ArrayBuffer);
	});

	test('passes an absent text transcript through as undefined', async () => {
		const process = vi.fn<VoiceProcessor['process']>(async () => ({
			transcript: 'Recovered note',
			draft: emptyDraft,
			clarificationPrompt: null,
		}));
		const { d1, request } = fixture({ process });
		d1.queue(
			{ kind: 'first', value: voice({ transcript: null }) },
			{ kind: 'first', value: car() },
			{ kind: 'run' },
			{ kind: 'run' },
			{
				kind: 'first',
				value: voice({ status: 'needs-review', transcript: 'Recovered note' }),
			},
		);
		expect(
			(
				await request(`/api/v1/voice-updates/${id}/process`, {
					method: 'POST',
				})
			).status,
		).toBe(200);
		expect(process.mock.calls[0]?.[0].text).toBeUndefined();
	});

	test.each([
		['provider failure', new Error('upstream'), 'could not be processed'],
		['non-error provider failure', 'upstream', 'could not be processed'],
		[
			'no speech',
			new Error('No speech was detected'),
			'No speech was detected',
		],
	] as const)(
		'retains a retryable failed state after %s',
		async (_case, failure, message) => {
			vi.spyOn(console, 'error').mockImplementation(() => undefined);
			const { d1, request } = fixture(
				processor(async () => Promise.reject(failure)),
			);
			d1.queue(
				{ kind: 'first', value: voice() },
				{ kind: 'first', value: car() },
				{ kind: 'run' },
				{ kind: 'run' },
				{ kind: 'first', value: voice({ status: 'failed', error: message }) },
			);
			const response = await request(`/api/v1/voice-updates/${id}/process`, {
				method: 'POST',
			});
			expect(response.status).toBe(_case === 'no speech' ? 422 : 502);
			expect((await response.json()) as { error: string }).toMatchObject({
				error: expect.stringContaining(message),
			});
		},
	);

	test('fails safely when stored audio is missing', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: voice({ objectKey: 'missing' }) },
			{ kind: 'first', value: car() },
			{ kind: 'run' },
			{ kind: 'run' },
			{ kind: 'first', value: null },
		);
		expect(
			(
				await request(`/api/v1/voice-updates/${id}/process`, {
					method: 'POST',
				})
			).status,
		).toBe(502);
	});

	test('logs only stage-safe processing failure metadata', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const upstream = Object.assign(new Error('provider details'), {
			name: 'InferenceUpstreamError',
		});
		const { d1, request } = fixture(
			processor(async () => {
				throw new VoiceProcessingError('provider details', 'extraction', 2, {
					cause: upstream,
				});
			}),
		);
		d1.queue(
			{ kind: 'first', value: voice() },
			{ kind: 'first', value: car() },
			{ kind: 'run' },
			{ kind: 'run' },
			{ kind: 'first', value: voice({ status: 'failed' }) },
		);
		const response = await request(`/api/v1/voice-updates/${id}/process`, {
			method: 'POST',
		});
		expect(response.status).toBe(502);
		expect(log).toHaveBeenCalledWith('voice processing failed', {
			voiceUpdateId: id,
			stage: 'extraction',
			errorName: 'InferenceUpstreamError',
			attemptCount: 2,
		});
	});

	test('fails loudly if a processed voice update cannot be reloaded', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: voice() },
			{ kind: 'first', value: car() },
			{ kind: 'run' },
			{ kind: 'run' },
			{ kind: 'first', value: null },
		);
		expect(
			(
				await request(`/api/v1/voice-updates/${id}/process`, {
					method: 'POST',
				})
			).status,
		).toBe(500);
	});

	test.each([
		['missing', null, [], 404],
		['saved', voice({ status: 'saved' }), [], 409],
		['discarded', voice({ status: 'discarded' }), [], 409],
		['processing', voice({ status: 'processing' }), [], 202],
		['missing car', voice(), [null], 404],
		['archived car', voice(), [car({ archivedAt: now })], 409],
	] as const)(
		'rejects or reports %s processing state',
		async (_case, row, rows, status) => {
			const { d1, request } = fixture();
			d1.queue({ kind: 'first', value: row });
			for (const value of rows) d1.queue({ kind: 'first', value });
			expect(
				(
					await request(`/api/v1/voice-updates/${id}/process`, {
						method: 'POST',
					})
				).status,
			).toBe(status);
		},
	);

	test('applies a text correction and retains provenance', async () => {
		const revised = {
			...emptyDraft,
			unmappedNotes: ['Rear diff, not front'],
		};
		const process = vi.fn<VoiceProcessor['process']>(async () => ({
			transcript: 'Rear diff, not front',
			draft: revised,
			clarificationPrompt: null,
		}));
		const { d1, request } = fixture({ process });
		d1.queue(
			{
				kind: 'first',
				value: voice({
					status: 'needs-review',
					draftJson: JSON.stringify(emptyDraft),
				}),
			},
			{ kind: 'first', value: car() },
			{ kind: 'run' },
			{
				kind: 'first',
				value: voice({
					status: 'needs-review',
					draftJson: JSON.stringify(revised),
					correctionsJson: JSON.stringify([
						{
							id: 'correction-1',
							kind: 'text',
							transcript: 'Rear diff, not front',
							createdAt: now,
						},
					]),
				}),
			},
		);
		const response = await request(
			`/api/v1/voice-updates/${id}/corrections`,
			json({ text: 'Rear diff, not front' }),
		);
		expect(response.status).toBe(200);
		expect(process.mock.calls[0]?.[0].previous?.draft).toEqual(emptyDraft);
	});

	test('rejects a correction when the stored draft is absent', async () => {
		const { d1, request } = fixture();
		d1.queue({
			kind: 'first',
			value: voice({ status: 'needs-review', draftJson: null }),
		});
		expect(
			(
				await request(
					`/api/v1/voice-updates/${id}/corrections`,
					json({ text: 'fix' }),
				)
			).status,
		).toBe(409);
	});

	test('rejects a correction when the stored draft is malformed JSON', async () => {
		const { d1, request } = fixture();
		d1.queue({
			kind: 'first',
			value: voice({ status: 'needs-review', draftJson: '{malformed' }),
		});
		const response = await request(
			`/api/v1/voice-updates/${id}/corrections`,
			json({ text: 'fix' }),
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: 'The current draft is unavailable',
		});
	});

	test('stores and applies a private voice correction', async () => {
		const { d1, r2, request } = fixture();
		d1.queue(
			{
				kind: 'first',
				value: voice({
					status: 'needs-review',
					draftJson: JSON.stringify(emptyDraft),
				}),
			},
			{ kind: 'first', value: car() },
			{ kind: 'run' },
			{
				kind: 'first',
				value: voice({
					status: 'needs-review',
					draftJson: JSON.stringify(emptyDraft),
					correctionsJson: JSON.stringify([
						{
							id: 'correction-1',
							kind: 'voice',
							transcript: 'fix',
							objectKey: 'key',
							createdAt: now,
						},
					]),
				}),
			},
		);
		const body = new FormData();
		body.set('file', new File(['voice'], 'fix.webm', { type: 'audio/webm' }));
		const response = await request(`/api/v1/voice-updates/${id}/corrections`, {
			method: 'POST',
			body,
		});
		expect(response.status).toBe(200);
		expect(r2.objects.size).toBe(1);
	});

	test('compensates failed voice correction storage', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const { d1, r2, request } = fixture(
			processor(async () => Promise.reject(new Error('bad correction'))),
		);
		d1.queue(
			{
				kind: 'first',
				value: voice({
					status: 'needs-review',
					draftJson: JSON.stringify(emptyDraft),
				}),
			},
			{ kind: 'first', value: car() },
		);
		const body = new FormData();
		body.set('file', new File(['voice'], 'fix.webm', { type: 'audio/webm' }));
		expect(
			(
				await request(`/api/v1/voice-updates/${id}/corrections`, {
					method: 'POST',
					body,
				})
			).status,
		).toBe(502);
		expect(r2.objects.size).toBe(0);
	});

	test('retains a text draft when correction processing throws a non-error', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const { d1, request } = fixture(
			processor(async () => Promise.reject('provider unavailable')),
		);
		d1.queue(
			{
				kind: 'first',
				value: voice({
					status: 'needs-review',
					draftJson: JSON.stringify(emptyDraft),
				}),
			},
			{ kind: 'first', value: car() },
		);
		expect(
			(
				await request(
					`/api/v1/voice-updates/${id}/corrections`,
					json({ text: 'Rear, not front' }),
				)
			).status,
		).toBe(502);
	});

	test('fails loudly if a corrected draft cannot be reloaded', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{
				kind: 'first',
				value: voice({
					status: 'needs-review',
					draftJson: JSON.stringify(emptyDraft),
				}),
			},
			{ kind: 'first', value: car() },
			{ kind: 'run' },
			{ kind: 'first', value: null },
		);
		expect(
			(
				await request(
					`/api/v1/voice-updates/${id}/corrections`,
					json({ text: 'Rear, not front' }),
				)
			).status,
		).toBe(500);
	});

	test.each([
		['missing', null, [], json({ text: 'fix' }), 404],
		['pending', voice(), [], json({ text: 'fix' }), 409],
		[
			'invalid draft',
			voice({ status: 'needs-review', draftJson: '{}' }),
			[],
			json({ text: 'fix' }),
			409,
		],
		[
			'missing car',
			voice({ status: 'needs-review', draftJson: JSON.stringify(emptyDraft) }),
			[null],
			json({ text: 'fix' }),
			404,
		],
		[
			'archived car',
			voice({ status: 'needs-review', draftJson: JSON.stringify(emptyDraft) }),
			[car({ archivedAt: now })],
			json({ text: 'fix' }),
			409,
		],
		[
			'invalid text',
			voice({ status: 'needs-review', draftJson: JSON.stringify(emptyDraft) }),
			[car()],
			json({ text: '' }),
			400,
		],
	] as const)(
		'rejects %s correction',
		async (_case, row, rows, init, status) => {
			const { d1, request } = fixture();
			d1.queue({ kind: 'first', value: row });
			for (const value of rows) d1.queue({ kind: 'first', value });
			expect(
				(await request(`/api/v1/voice-updates/${id}/corrections`, init)).status,
			).toBe(status);
		},
	);

	test('rejects a correction form without supported audio', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{
				kind: 'first',
				value: voice({
					status: 'needs-review',
					draftJson: JSON.stringify(emptyDraft),
				}),
			},
			{ kind: 'first', value: car() },
		);
		const body = new FormData();
		body.set('file', new File(['bad'], 'fix.txt', { type: 'text/plain' }));
		expect(
			(
				await request(`/api/v1/voice-updates/${id}/corrections`, {
					method: 'POST',
					body,
				})
			).status,
		).toBe(400);
	});

	test('rejects a correction request without content metadata or a file', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{
				kind: 'first',
				value: voice({
					status: 'needs-review',
					draftJson: JSON.stringify(emptyDraft),
				}),
			},
			{ kind: 'first', value: car() },
		);
		expect(
			(
				await request(`/api/v1/voice-updates/${id}/corrections`, {
					method: 'POST',
				})
			).status,
		).toBe(400);
	});

	test.each([
		[
			'saved provenance',
			voice({ status: 'saved' }),
			[{ kind: 'all', rows: [] }],
			200,
		],
		['missing provenance', null, [], 404],
	] as const)('reads %s results', async (_case, row, steps, status) => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'first', value: row });
		for (const step of steps) d1.queue(step);
		expect((await request(`/api/v1/voice-updates/${id}/results`)).status).toBe(
			status,
		);
	});
});
