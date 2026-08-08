import { afterEach, describe, expect, test } from 'vitest';
import {
	createHonoFixture,
	type MockD1Controller,
} from './testing/hono-fixture';

const id = '35ecb4da-0bb4-46cc-85d6-b02c7b3d9552';
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

const setup = (overrides: Record<string, unknown> = {}) => ({
	id: 'setup-1',
	carId: 'car-1',
	name: 'Base setup',
	status: 'active',
	setupDate: now,
	track: 'Club',
	event: null,
	surface: null,
	traction: null,
	moisture: null,
	condition: null,
	temperature: null,
	vehicle: '{"weight":"1500g"}',
	drivetrain: '{}',
	electronics: '{}',
	tires: '{}',
	shocks: '{}',
	frontSuspension: '{}',
	rearSuspension: '{}',
	notes: 'Keep this note',
	sourceUrl: null,
	sourcePdfReference: null,
	sourceMetadata: '{"source":"manual"}',
	copiedFromId: null,
	rawValues: null,
	unmappedValues: null,
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
	notes: 'Run one',
	deletedAt: null,
	...overrides,
});

const fact = (overrides: Record<string, unknown> = {}) => ({
	confidence: 'high',
	needsReview: false,
	sourceText: 'spoken fact',
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

const comprehensiveDraft = {
	setupChanges: [
		fact({ section: 'context', field: 'unknown-context', value: 'kept' }),
		fact({ section: 'vehicle', field: 'rideHeight', value: '18mm' }),
		fact({ section: 'drivetrain', field: 'slipper', value: 'tight' }),
		fact({ section: 'electronics', field: 'timing', value: 10 }),
		fact({ section: 'tires', field: 'compound', value: 'silver' }),
		fact({ section: 'shocks', field: 'oil', value: '35wt' }),
		fact({ section: 'frontSuspension', field: 'camber', value: -1 }),
		fact({ section: 'rearSuspension', field: 'camber', value: -2 }),
		fact({
			section: 'context',
			field: 'track',
			value: 'Maybe club',
			confidence: 'low',
			needsReview: true,
			sourceText: 'maybe at club',
		}),
	],
	problems: [
		fact({ text: 'Rear stepped out' }),
		fact({
			text: 'Maybe pushed',
			confidence: 'low',
			needsReview: true,
			sourceText: 'maybe pushed',
		}),
	],
	conditions: [
		fact({ field: 'track', value: 'Club' }),
		fact({ field: 'event', value: 'Practice' }),
		fact({ field: 'surface', value: 'Clay' }),
		fact({ field: 'traction', value: 'High' }),
		fact({ field: 'moisture', value: 'Damp' }),
		fact({ field: 'condition', value: 'Grooved' }),
		fact({ field: 'temperature', value: '72F' }),
		fact({
			field: 'condition',
			value: 'Maybe dusty',
			confidence: 'low',
			needsReview: true,
			sourceText: 'maybe dusty',
		}),
	],
	driveSessionNotes: [
		fact({ text: 'Faster in sweepers' }),
		fact({
			text: 'Maybe noisy',
			confidence: 'low',
			needsReview: true,
			sourceText: 'maybe noisy',
		}),
	],
	consumables: [
		fact({ kind: 'tires', axle: 'both', details: 'New silver tires' }),
		fact({ kind: 'tires', axle: 'front', sourceText: 'New front tires' }),
		fact({ kind: 'tires', axle: 'rear', sourceText: 'New rear tires' }),
		fact({
			kind: 'fluid',
			fluidArea: 'custom',
			customFluidArea: 'center differential',
			details: '7k fluid',
		}),
		fact({
			kind: 'fluid',
			fluidArea: 'rear-shocks',
			notes: 'Refilled after rebuild',
		}),
		fact({
			kind: 'fluid',
			fluidArea: 'front-differential',
			sourceText: 'Changed front diff fluid',
		}),
		fact({
			kind: 'fluid',
			fluidArea: 'front-shocks',
			confidence: 'low',
			needsReview: true,
			sourceText: 'maybe front shock oil',
		}),
	],
	unmappedNotes: ['Motor sounded different'],
	unresolvedNotes: ['Could not hear the spring color'],
};

const voice = (overrides: Record<string, unknown> = {}) => ({
	id,
	ownerId: 'owner-1',
	carId: 'car-1',
	driveSessionId: null,
	objectKey: 'voice-key',
	contentType: 'audio/webm',
	fileName: 'note.webm',
	byteSize: 5,
	status: 'needs-review',
	transcript: 'Track note',
	draftJson: JSON.stringify(emptyDraft),
	correctionsJson: null,
	clarificationPrompt: null,
	error: null,
	confirmedAt: null,
	artifactDeletedAt: null,
	createdAt: now,
	updatedAt: now,
	...overrides,
});

const result = (overrides: Record<string, unknown> = {}) => ({
	id: `${id}:result:0`,
	voiceUpdateId: id,
	kind: 'setup',
	recordId: `${id}:setup`,
	label: 'New setup snapshot',
	createdAt: now,
	...overrides,
});

const confirm = (acceptUnresolvedAsNotes = false): RequestInit => ({
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ acceptUnresolvedAsNotes }),
});

let current: MockD1Controller | undefined;
const fixture = () => {
	const value = createHonoFixture();
	current = value.d1;
	return value;
};

afterEach(() => {
	current?.expectConsumed();
	current = undefined;
});

describe('voice confirmation routes', () => {
	test('confirms every supported domain fact in one idempotent batch', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{
				kind: 'first',
				value: voice({
					driveSessionId: 'drive-1',
					draftJson: JSON.stringify(comprehensiveDraft),
				}),
			},
			{ kind: 'first', value: car({ currentSetupId: 'setup-1' }) },
			{ kind: 'first', value: setup() },
			{ kind: 'first', value: drive() },
			{ kind: 'batch' },
			{
				kind: 'first',
				value: voice({
					status: 'saved',
					driveSessionId: 'drive-1',
					draftJson: JSON.stringify(comprehensiveDraft),
					confirmedAt: now,
				}),
			},
			{
				kind: 'all',
				rows: [
					result(),
					result({
						id: 'drive-result',
						kind: 'drive-session',
						recordId: 'drive-1',
					}),
					result({
						id: 'problem-result',
						kind: 'problem-note',
						recordId: 'problem-1',
					}),
					result({
						id: 'consumable-result',
						kind: 'consumable',
						recordId: 'entry-1',
					}),
				],
			},
		);
		const response = await request(
			`/api/v1/voice-updates/${id}/confirm`,
			confirm(true),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			voiceUpdate: { status: 'saved', results: expect.any(Array) },
		});
		const batch = d1.queries.find((query) => query.operation === 'batch');
		expect(batch).toBeDefined();
	});

	test('creates a setup and drive history when no prior context exists', async () => {
		const draft = {
			...emptyDraft,
			conditions: [fact({ field: 'track', value: 'New track' })],
		};
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: voice({ draftJson: JSON.stringify(draft) }) },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: null },
			{ kind: 'batch' },
			{
				kind: 'first',
				value: voice({
					status: 'saved',
					draftJson: JSON.stringify(draft),
					driveSessionId: `${id}:drive`,
				}),
			},
			{ kind: 'all', rows: [] },
		);
		expect(
			(await request(`/api/v1/voice-updates/${id}/confirm`, confirm())).status,
		).toBe(200);
	});

	test('creates a derived drive before confirmation references it', async () => {
		const draft = {
			...emptyDraft,
			unmappedNotes: ['Free-form track note'],
		};
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: voice({ draftJson: JSON.stringify(draft) }) },
			{ kind: 'first', value: car() },
			{ kind: 'batch' },
			{
				kind: 'first',
				value: voice({
					status: 'saved',
					draftJson: JSON.stringify(draft),
					driveSessionId: `${id}:drive`,
				}),
			},
			{ kind: 'all', rows: [] },
		);

		expect(
			(await request(`/api/v1/voice-updates/${id}/confirm`, confirm())).status,
		).toBe(200);
		const statements = d1.batches[0] ?? [];
		const driveInsert = statements.findIndex((query) =>
			query.startsWith('insert into "drive_session"'),
		);
		const confirmationUpdate = statements.findIndex((query) =>
			query.startsWith('update "voice_update"'),
		);
		expect(driveInsert).toBeGreaterThanOrEqual(0);
		expect(confirmationUpdate).toBeGreaterThanOrEqual(0);
		expect(driveInsert).toBeLessThan(confirmationUpdate);
	});

	test('creates an empty-section setup map when there is no prior setup', async () => {
		const draft = {
			...emptyDraft,
			setupChanges: [
				fact({ section: 'vehicle', field: 'rideHeight', value: '18mm' }),
			],
		};
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: voice({ draftJson: JSON.stringify(draft) }) },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: null },
			{ kind: 'batch' },
			{
				kind: 'first',
				value: voice({ status: 'saved', draftJson: JSON.stringify(draft) }),
			},
			{ kind: 'all', rows: [] },
		);
		expect(
			(await request(`/api/v1/voice-updates/${id}/confirm`, confirm())).status,
		).toBe(200);
	});

	test('falls back from a stale current setup to latest history', async () => {
		const draft = {
			...emptyDraft,
			setupChanges: [
				fact({ section: 'context', field: 'track', value: 'Club' }),
			],
		};
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: voice({ draftJson: JSON.stringify(draft) }) },
			{ kind: 'first', value: car({ currentSetupId: 'stale' }) },
			{ kind: 'first', value: setup({ id: 'stale', carId: 'car-2' }) },
			{ kind: 'first', value: setup() },
			{ kind: 'batch' },
			{
				kind: 'first',
				value: voice({ status: 'saved', draftJson: JSON.stringify(draft) }),
			},
			{ kind: 'all', rows: [] },
		);
		expect(
			(await request(`/api/v1/voice-updates/${id}/confirm`, confirm())).status,
		).toBe(200);
	});

	test('keeps an explicitly selected session unchanged for an empty draft', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: voice({ driveSessionId: 'drive-1' }) },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: drive() },
			{ kind: 'batch' },
			{
				kind: 'first',
				value: voice({ status: 'saved', driveSessionId: 'drive-1' }),
			},
			{ kind: 'all', rows: [] },
		);
		expect(
			(await request(`/api/v1/voice-updates/${id}/confirm`, confirm())).status,
		).toBe(200);
	});

	test.each([
		['missing', null, [], confirm(), 404],
		[
			'already saved',
			voice({ status: 'saved' }),
			[{ kind: 'all', rows: [result()] }],
			confirm(),
			200,
		],
		['pending', voice({ status: 'pending' }), [], confirm(), 409],
		['missing car', voice(), [{ kind: 'first', value: null }], confirm(), 404],
		[
			'archived car',
			voice(),
			[{ kind: 'first', value: car({ archivedAt: now }) }],
			confirm(),
			409,
		],
		[
			'invalid confirmation',
			voice(),
			[{ kind: 'first', value: car() }],
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ acceptUnresolvedAsNotes: 'yes' }),
			},
			400,
		],
		[
			'invalid draft',
			voice({ draftJson: '{}' }),
			[{ kind: 'first', value: car() }],
			confirm(),
			409,
		],
	] as const)(
		'handles %s confirmation',
		async (_case, row, steps, init, status) => {
			const { d1, request } = fixture();
			d1.queue({ kind: 'first', value: row });
			for (const step of steps) d1.queue(step);
			expect(
				(await request(`/api/v1/voice-updates/${id}/confirm`, init)).status,
			).toBe(status);
		},
	);

	test('requires an explicit choice for uncertain extraction', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{
				kind: 'first',
				value: voice({ draftJson: JSON.stringify(comprehensiveDraft) }),
			},
			{ kind: 'first', value: car() },
		);
		const response = await request(
			`/api/v1/voice-updates/${id}/confirm`,
			confirm(),
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ needsReview: 6 });
	});

	test('rejects confirmation when the stored draft is absent', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: voice({ draftJson: null }) },
			{ kind: 'first', value: car() },
		);
		expect(
			(await request(`/api/v1/voice-updates/${id}/confirm`, confirm())).status,
		).toBe(409);
	});

	test.each([
		['missing', null],
		['deleted', drive({ deletedAt: now })],
	] as const)(
		'rejects a %s selected drive session',
		async (_case, selected) => {
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'first', value: voice({ driveSessionId: 'drive-1' }) },
				{ kind: 'first', value: car() },
				{ kind: 'first', value: selected },
			);
			expect(
				(await request(`/api/v1/voice-updates/${id}/confirm`, confirm()))
					.status,
			).toBe(409);
		},
	);

	test('returns the winning idempotent save after a batch race', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: voice() },
			{ kind: 'first', value: car() },
			{ kind: 'error', error: new Error('unique collision') },
			{ kind: 'first', value: voice({ status: 'saved' }) },
			{ kind: 'first', value: voice({ status: 'saved' }) },
			{ kind: 'all', rows: [] },
		);
		expect(
			(await request(`/api/v1/voice-updates/${id}/confirm`, confirm())).status,
		).toBe(200);
	});

	test('surfaces a non-idempotent batch failure', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: voice() },
			{ kind: 'first', value: car() },
			{ kind: 'error', error: new Error('database unavailable') },
			{ kind: 'first', value: voice() },
		);
		expect(
			(await request(`/api/v1/voice-updates/${id}/confirm`, confirm())).status,
		).toBe(500);
	});

	test('fails loudly if a confirmed update cannot be reloaded', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: voice() },
			{ kind: 'first', value: car() },
			{ kind: 'batch' },
			{ kind: 'first', value: null },
		);
		expect(
			(await request(`/api/v1/voice-updates/${id}/confirm`, confirm())).status,
		).toBe(500);
	});
});
