import { afterEach, describe, expect, test, vi } from 'vitest';
import {
	createHonoFixture,
	type MockD1Controller,
} from './testing/hono-fixture';
import type { VoiceProcessor } from './voice-processing';

const captureId = '35ecb4da-0bb4-46cc-85d6-b02c7b3d9552';
const now = '2026-08-08T01:00:00.000Z';

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

const voice = (overrides: Record<string, unknown> = {}) => ({
	id: captureId,
	ownerId: 'owner-1',
	carId: 'car-1',
	driveSessionId: null,
	objectKey: null,
	contentType: null,
	fileName: null,
	byteSize: 0,
	status: 'pending',
	transcript: 'The rear stepped out',
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

const drive = (overrides: Record<string, unknown> = {}) => ({
	id: 'drive-1',
	carId: 'car-1',
	startedAt: now,
	durationMinutes: 5,
	conditions: 'Dry',
	notes: null,
	deletedAt: null,
	...overrides,
});

const result = (overrides: Record<string, unknown> = {}) => ({
	id: `${captureId}:result:0`,
	voiceUpdateId: captureId,
	kind: 'setup',
	recordId: `${captureId}:setup`,
	label: 'New setup snapshot',
	createdAt: now,
	...overrides,
});

const emptyDraft = {
	setupChanges: [],
	problems: [],
	conditions: [],
	driveSessionNotes: [],
	consumables: [],
	unmappedNotes: [],
	unresolvedNotes: [],
};

const json = (method: string, body: unknown): RequestInit => ({
	method,
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body),
});

const captureForm = (
	overrides: Record<string, string> = {},
	file: File | null = new File(['voice'], 'note.webm', {
		type: 'audio/webm',
	}),
): RequestInit => {
	const body = new FormData();
	body.set('captureId', overrides.captureId ?? captureId);
	if (overrides.driveSessionId)
		body.set('driveSessionId', overrides.driveSessionId);
	if (file) body.set('file', file);
	return { method: 'POST', body };
};

let current: MockD1Controller | undefined;
const fixture = (processor?: VoiceProcessor) => {
	const value = createHonoFixture(
		processor ? { voiceProcessor: processor } : undefined,
	);
	current = value.d1;
	return value;
};

afterEach(() => {
	current?.expectConsumed();
	current = undefined;
	vi.restoreAllMocks();
});

describe('voice capture and provenance routes', () => {
	test('lists owner-scoped voice updates for an owned car', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: car() },
			{
				kind: 'all',
				rows: [
					voice({
						draftJson: JSON.stringify(emptyDraft),
						correctionsJson: 'not-json',
					}),
				],
			},
		);
		const response = await request('/api/v1/cars/car-1/voice-updates');
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			voiceUpdates: [{ id: captureId, draft: emptyDraft, corrections: [] }],
		});
	});

	test('hides a voice collection for an unowned car', async () => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'first', value: null });
		expect((await request('/api/v1/cars/car-1/voice-updates')).status).toBe(
			404,
		);
	});

	test('creates an idempotent text capture', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: car() },
			{ kind: 'first', value: null },
			{ kind: 'run' },
			{ kind: 'first', value: voice() },
		);
		const response = await request(
			'/api/v1/cars/car-1/voice-updates',
			json('POST', { captureId, text: 'The rear stepped out' }),
		);
		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({
			voiceUpdate: { id: captureId, transcript: 'The rear stepped out' },
		});
	});

	test('rejects a capture request without a body content type', async () => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'first', value: car() });
		expect(
			(
				await request('/api/v1/cars/car-1/voice-updates', {
					method: 'POST',
				})
			).status,
		).toBe(400);
	});

	test.each([
		['same car', voice(), 200],
		['different car', voice({ carId: 'car-2' }), 409],
	] as const)(
		'handles an existing capture on the %s',
		async (_case, row, status) => {
			const { d1, request } = fixture();
			d1.queue({ kind: 'first', value: car() }, { kind: 'first', value: row });
			expect(
				(
					await request(
						'/api/v1/cars/car-1/voice-updates',
						json('POST', { captureId, text: 'retry' }),
					)
				).status,
			).toBe(status);
		},
	);

	test.each([
		['missing car', null, { captureId, text: 'note' }, 404],
		[
			'archived car',
			car({ archivedAt: now }),
			{ captureId, text: 'note' },
			409,
		],
		['invalid body', car(), { captureId: 'bad', text: '' }, 400],
	] as const)(
		'rejects a text capture for %s',
		async (_case, parent, body, status) => {
			const { d1, request } = fixture();
			d1.queue({ kind: 'first', value: parent });
			const response = await request(
				'/api/v1/cars/car-1/voice-updates',
				json('POST', body),
			);
			expect(response.status).toBe(status);
		},
	);

	test('rejects a non-text multipart capture id', async () => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'first', value: car() });
		const body = new FormData();
		body.set('captureId', new File(['id'], 'id.txt'));
		body.set('file', new File(['voice'], 'note.webm', { type: 'audio/webm' }));
		expect(
			(
				await request('/api/v1/cars/car-1/voice-updates', {
					method: 'POST',
					body,
				})
			).status,
		).toBe(400);
	});

	test('requires an owned drive-session context', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: car() },
			{ kind: 'first', value: null },
			{ kind: 'first', value: null },
		);
		const response = await request(
			'/api/v1/cars/car-1/voice-updates',
			json('POST', { captureId, text: 'note', driveSessionId: 'missing' }),
		);
		expect(response.status).toBe(404);
	});

	test('stores a private audio capture and its drive context', async () => {
		const { d1, r2, request } = fixture();
		d1.queue(
			{ kind: 'first', value: car() },
			{ kind: 'first', value: null },
			{ kind: 'first', value: drive() },
			{ kind: 'run' },
			{
				kind: 'first',
				value: voice({
					driveSessionId: 'drive-1',
					objectKey: `voice/owner-1/car-1/${captureId}`,
					contentType: 'audio/webm',
					fileName: 'note.webm',
					byteSize: 5,
					transcript: null,
				}),
			},
		);
		const response = await request(
			'/api/v1/cars/car-1/voice-updates',
			captureForm({ driveSessionId: 'drive-1' }),
		);
		expect(response.status).toBe(201);
		expect(r2.objects.size).toBe(1);
	});

	test('accepts the codec-qualified WebM type produced by the browser recorder', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: car() },
			{ kind: 'first', value: null },
			{ kind: 'run' },
			{
				kind: 'first',
				value: voice({
					objectKey: `voice/owner-1/car-1/${captureId}`,
					contentType: 'audio/webm;codecs=opus',
					fileName: 'note.webm',
					byteSize: 5,
					transcript: null,
				}),
			},
		);
		const response = await request(
			'/api/v1/cars/car-1/voice-updates',
			captureForm(
				{},
				new File(['voice'], 'note.webm', {
					type: 'audio/webm;codecs=opus',
				}),
			),
		);
		expect(response.status).toBe(201);
	});

	test.each([
		['invalid id', captureForm({ captureId: 'bad' }), 400],
		['missing file', captureForm({}, null), 400],
		[
			'unsupported file',
			captureForm({}, new File(['text'], 'note.txt', { type: 'text/plain' })),
			400,
		],
	] as const)(
		'rejects multipart capture with %s',
		async (_case, init, status) => {
			const { d1, request } = fixture();
			d1.queue({ kind: 'first', value: car() });
			expect(
				(await request('/api/v1/cars/car-1/voice-updates', init)).status,
			).toBe(status);
		},
	);

	test('surfaces a failed text insert without R2 compensation', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: car() },
			{ kind: 'first', value: null },
			{ kind: 'error', error: new Error('insert failed') },
			{ kind: 'first', value: null },
		);
		expect(
			(
				await request(
					'/api/v1/cars/car-1/voice-updates',
					json('POST', { captureId, text: 'note' }),
				)
			).status,
		).toBe(500);
	});

	test('fails loudly if a newly inserted capture cannot be reloaded', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: car() },
			{ kind: 'first', value: null },
			{ kind: 'run' },
			{ kind: 'first', value: null },
		);
		expect(
			(
				await request(
					'/api/v1/cars/car-1/voice-updates',
					json('POST', { captureId, text: 'note' }),
				)
			).status,
		).toBe(500);
	});

	test.each([
		['no winner', null, 500, 0],
		[
			'idempotent winner',
			voice({
				objectKey: `voice/owner-1/car-1/${captureId}`,
				contentType: 'audio/webm',
				fileName: 'note.webm',
				byteSize: 5,
			}),
			200,
			1,
		],
	] as const)(
		'compensates a failed audio insert with %s',
		async (_case, raced, status, objectCount) => {
			const { d1, r2, request } = fixture();
			d1.queue(
				{ kind: 'first', value: car() },
				{ kind: 'first', value: null },
				{ kind: 'error', error: new Error('insert failed') },
				{ kind: 'first', value: raced },
			);
			const response = await request(
				'/api/v1/cars/car-1/voice-updates',
				captureForm(),
			);
			expect(response.status).toBe(status);
			expect(r2.objects.size).toBe(objectCount);
		},
	);

	test('reads a voice update with links to every derived record kind', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{
				kind: 'first',
				value: voice({
					status: 'saved',
					draftJson: JSON.stringify(emptyDraft),
					correctionsJson: JSON.stringify([
						null,
						{
							id: 'correction-1',
							kind: 'text',
							transcript: 'rear, not front',
							createdAt: now,
						},
						{ id: 42 },
					]),
				}),
			},
			{
				kind: 'all',
				rows: [
					result(),
					result({ id: 'r2', kind: 'drive-session', recordId: 'drive-1' }),
					result({ id: 'r3', kind: 'consumable', recordId: 'c-1' }),
					result({ id: 'r4', kind: 'problem-note', recordId: 'p-1' }),
				],
			},
		);
		const response = await request(`/api/v1/voice-updates/${captureId}`);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			voiceUpdate: { results: Array<{ url: string }>; corrections: unknown[] };
		};
		expect(body.voiceUpdate.results.map((item) => item.url)).toEqual([
			'/garage/car-1/setups',
			'/garage/car-1/runs',
			'/maintenance',
			'/garage/car-1/runs',
		]);
		expect(body.voiceUpdate.corrections).toHaveLength(1);
	});

	test('uses safe response metadata when stored audio metadata is absent', async () => {
		const { d1, r2, request } = fixture();
		r2.seed('voice-key', 'voice');
		d1.queue({
			kind: 'first',
			value: voice({
				objectKey: 'voice-key',
				contentType: null,
				fileName: null,
				byteSize: 5,
			}),
		});
		const response = await request(`/api/v1/voice-updates/${captureId}/audio`);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe(
			'application/octet-stream',
		);
		expect(response.headers.get('content-disposition')).toContain('voice-note');
	});

	test('hides an unowned voice update', async () => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'first', value: null });
		expect((await request(`/api/v1/voice-updates/${captureId}`)).status).toBe(
			404,
		);
	});

	test('streams private original and correction audio', async () => {
		const { d1, r2, request } = fixture();
		const originalKey = `voice/owner-1/car-1/${captureId}`;
		const correctionKey = `${originalKey}/corrections/correction-1`;
		r2.seed(originalKey, 'voice', { contentType: 'audio/webm' });
		r2.seed(correctionKey, 'fix', { contentType: 'audio/webm' });
		d1.queue(
			{
				kind: 'first',
				value: voice({
					objectKey: originalKey,
					contentType: 'audio/webm',
					fileName: 'note".webm',
					byteSize: 5,
				}),
			},
			{
				kind: 'first',
				value: voice({
					correctionsJson: JSON.stringify([
						{
							id: 'correction-1',
							kind: 'voice',
							transcript: 'rear',
							objectKey: correctionKey,
							createdAt: now,
						},
					]),
				}),
			},
		);
		const original = await request(`/api/v1/voice-updates/${captureId}/audio`);
		expect(original.status).toBe(200);
		expect(original.headers.get('cache-control')).toBe('private, no-store');
		const correction = await request(
			`/api/v1/voice-updates/${captureId}/corrections/correction-1/audio`,
		);
		expect(correction.status).toBe(200);
	});

	test.each([
		['missing metadata', null, '/audio'],
		[
			'deleted artifact',
			voice({ objectKey: 'key', artifactDeletedAt: now }),
			'/audio',
		],
		['missing object', voice({ objectKey: 'key' }), '/audio'],
		['missing correction owner', null, '/corrections/correction-1/audio'],
		['missing correction', voice(), '/corrections/correction-1/audio'],
		[
			'missing correction object',
			voice({
				correctionsJson: JSON.stringify([
					{
						id: 'correction-1',
						kind: 'voice',
						transcript: 'fix',
						objectKey: 'missing',
						createdAt: now,
					},
				]),
			}),
			'/corrections/correction-1/audio',
		],
	] as const)('hides %s audio', async (_case, row, suffix) => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'first', value: row });
		expect(
			(await request(`/api/v1/voice-updates/${captureId}${suffix}`)).status,
		).toBe(404);
	});

	test('updates draft, provenance, and owner-scoped context', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: voice() },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: drive() },
			{ kind: 'run' },
			{
				kind: 'first',
				value: voice({
					driveSessionId: 'drive-1',
					draftJson: JSON.stringify(emptyDraft),
					correctionsJson: JSON.stringify([
						{
							id: 'manual-1',
							kind: 'manual',
							transcript: 'manual fix',
							createdAt: now,
						},
					]),
				}),
			},
			{ kind: 'all', rows: [] },
		);
		const response = await request(
			`/api/v1/voice-updates/${captureId}`,
			json('PATCH', {
				driveSessionId: 'drive-1',
				draft: emptyDraft,
				correction: 'manual fix',
			}),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			voiceUpdate: { driveSessionId: 'drive-1', draft: emptyDraft },
		});
	});

	test('keeps the current drive context when a patch omits it', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: voice({ driveSessionId: 'drive-1' }) },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: drive() },
			{ kind: 'run' },
			{
				kind: 'first',
				value: voice({ driveSessionId: 'drive-1', correctionsJson: '[]' }),
			},
			{ kind: 'all', rows: [] },
		);
		const response = await request(
			`/api/v1/voice-updates/${captureId}`,
			json('PATCH', { correction: 'Keep this run' }),
		);
		expect(response.status).toBe(200);
	});

	test('clears inherited drive context when moving a capture to another car', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: voice({ driveSessionId: 'drive-1' }) },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: car({ id: 'car-2' }) },
			{ kind: 'run' },
			{
				kind: 'first',
				value: voice({ carId: 'car-2', driveSessionId: null }),
			},
			{ kind: 'all', rows: [] },
		);
		const response = await request(
			`/api/v1/voice-updates/${captureId}`,
			json('PATCH', { carId: 'car-2' }),
		);
		expect(response.status).toBe(200);
	});

	test('fails loudly if a patched voice update cannot be reloaded', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: voice() },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: car() },
			{ kind: 'run' },
			{ kind: 'first', value: null },
		);
		expect(
			(
				await request(
					`/api/v1/voice-updates/${captureId}`,
					json('PATCH', { correction: 'fix' }),
				)
			).status,
		).toBe(500);
	});

	test.each([
		['missing', null, [], {}, 404],
		['saved', voice({ status: 'saved' }), [], {}, 409],
		['discarded', voice({ status: 'discarded' }), [], {}, 409],
		['archived source', voice(), [car({ archivedAt: now })], {}, 409],
		['invalid body', voice(), [car()], {}, 400],
		['missing target', voice(), [car(), null], { carId: 'car-2' }, 404],
		[
			'archived target',
			voice(),
			[car(), car({ id: 'car-2', archivedAt: now })],
			{ carId: 'car-2' },
			409,
		],
		[
			'missing drive',
			voice(),
			[car(), car(), null],
			{ driveSessionId: 'missing' },
			404,
		],
	] as const)(
		'rejects patch for %s voice state',
		async (_case, row, rows, body, status) => {
			const { d1, request } = fixture();
			d1.queue({ kind: 'first', value: row });
			for (const value of rows) d1.queue({ kind: 'first', value });
			expect(
				(
					await request(
						`/api/v1/voice-updates/${captureId}`,
						json('PATCH', body),
					)
				).status,
			).toBe(status);
		},
	);

	test.each([
		[
			'pending without audio',
			voice(),
			voice({ status: 'discarded', artifactDeletedAt: now }),
			false,
		],
		[
			'saved with audio',
			voice({ status: 'saved', objectKey: 'voice-key' }),
			voice({ status: 'saved', artifactDeletedAt: now }),
			true,
		],
	] as const)(
		'applies artifact deletion policy to %s',
		async (_case, before, after, seeded) => {
			const { d1, r2, request } = fixture();
			if (seeded) r2.seed('voice-key', 'voice');
			d1.queue(
				{ kind: 'first', value: before },
				{ kind: 'first', value: car() },
				{ kind: 'run' },
				{ kind: 'first', value: after },
				{ kind: 'all', rows: [] },
			);
			const response = await request(`/api/v1/voice-updates/${captureId}`, {
				method: 'DELETE',
			});
			expect(response.status).toBe(200);
			expect(r2.objects.size).toBe(0);
		},
	);

	test.each([
		['missing', null, [], 404],
		['archived', voice(), [car({ archivedAt: now })], 409],
	] as const)(
		'rejects artifact deletion for %s update',
		async (_case, row, rows, status) => {
			const { d1, request } = fixture();
			d1.queue({ kind: 'first', value: row });
			for (const value of rows) d1.queue({ kind: 'first', value });
			expect(
				(
					await request(`/api/v1/voice-updates/${captureId}`, {
						method: 'DELETE',
					})
				).status,
			).toBe(status);
		},
	);

	test('fails loudly if an artifact deletion cannot be reloaded', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: voice() },
			{ kind: 'first', value: car() },
			{ kind: 'run' },
			{ kind: 'first', value: null },
		);
		expect(
			(
				await request(`/api/v1/voice-updates/${captureId}`, {
					method: 'DELETE',
				})
			).status,
		).toBe(500);
	});
});
