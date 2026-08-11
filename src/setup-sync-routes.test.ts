import { describe, expect, test } from 'vitest';
import { createHonoFixture, type D1Step } from './testing/hono-fixture';
import {
	setupCorrectSyncCommandInput,
	setupCreateSyncCommandInput,
	setupSelectCurrentSyncCommandInput,
} from './types';

const OPERATION_ID = '10000000-0000-4000-8000-000000000001';
const CAR_ID = '20000000-0000-4000-8000-000000000001';
const SETUP_ID = '30000000-0000-4000-8000-000000000001';
const SOURCE_ID = '40000000-0000-4000-8000-000000000001';

const canonicalJson = (value: unknown): string => {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value))
		return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(',')}}`;
};

const requestHash = async (value: unknown): Promise<string> => {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(canonicalJson(value)),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
};

const requestBody = (command: Readonly<Record<string, unknown>>) => ({
	contractVersion: 1,
	command,
});

const createCommand = (overrides: Readonly<Record<string, unknown>> = {}) => ({
	type: 'setup.create',
	carId: CAR_ID,
	setupId: SETUP_ID,
	copiedFromSetupId: null,
	setup: { name: 'Clay baseline', track: 'Home track' },
	makeCurrent: false,
	baseCurrent: null,
	...overrides,
});

const correctCommand = (overrides: Readonly<Record<string, unknown>> = {}) => ({
	type: 'setup.correct',
	carId: CAR_ID,
	setupId: SETUP_ID,
	baseVersion: 1,
	base: { track: 'Home track' },
	changes: { track: 'Away track' },
	...overrides,
});

const selectCommand = (overrides: Readonly<Record<string, unknown>> = {}) => ({
	type: 'setup.select-current',
	carId: CAR_ID,
	setupId: SETUP_ID,
	baseCurrent: { setupId: SOURCE_ID, version: 2 },
	...overrides,
});

const carRow = (overrides: Readonly<Record<string, unknown>> = {}) => ({
	id: CAR_ID,
	ownerId: 'owner-1',
	name: 'B7 buggy',
	make: 'Associated',
	model: 'B7',
	scale: '1/10',
	vehicleType: 'buggy',
	powerType: 'electric',
	notes: null,
	currentSetupId: SOURCE_ID,
	currentSetupVersion: 2,
	currentSetupOperationId: null,
	createdAt: '2026-08-10T00:00:00.000Z',
	archivedAt: null,
	version: 3,
	lastOperationId: null,
	...overrides,
});

const setupRow = (overrides: Readonly<Record<string, unknown>> = {}) => ({
	id: SETUP_ID,
	carId: CAR_ID,
	name: 'Clay baseline',
	status: 'active',
	setupDate: null,
	track: 'Home track',
	event: null,
	surface: null,
	traction: null,
	moisture: null,
	condition: null,
	temperature: null,
	vehicle: '{}',
	drivetrain: '{}',
	electronics: '{}',
	tires: '{}',
	shocks: '{}',
	frontSuspension: '{}',
	rearSuspension: '{}',
	notes: null,
	sourceUrl: null,
	sourcePdfReference: null,
	sourceMetadata: null,
	copiedFromId: null,
	rawValues: null,
	unmappedValues: null,
	createdAt: '2026-08-10T00:00:00.000Z',
	updatedAt: '2026-08-10T00:00:00.000Z',
	version: 1,
	lastOperationId: null,
	...overrides,
});

const pendingReceipt = async (
	body: ReturnType<typeof requestBody>,
	overrides: Readonly<Record<string, unknown>> = {},
) => ({
	ownerId: 'owner-1',
	operationId: OPERATION_ID,
	contractVersion: 1,
	kind: body.command['type'],
	entityType: 'setup',
	entityId: body.command['setupId'],
	requestHash: await requestHash(body),
	outcome: 'pending',
	httpStatus: null,
	responseJson: null,
	createdAt: '2026-08-11T00:00:00.000Z',
	completedAt: null,
	...overrides,
});

const terminalReceipt = async (
	body: ReturnType<typeof requestBody>,
	status: number,
	response: Readonly<Record<string, unknown>>,
) => ({
	...(await pendingReceipt(body)),
	outcome: response['outcome'],
	httpStatus: status,
	responseJson: JSON.stringify(response),
	completedAt: '2026-08-11T00:00:00.000Z',
});

const jsonRequest = (body: unknown): RequestInit => ({
	method: 'PUT',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body),
});

const apply = async (
	command: Readonly<Record<string, unknown>>,
	steps: readonly D1Step[],
) => {
	const body = requestBody(command);
	const { d1, request } = createHonoFixture();
	d1.queue({ kind: 'first', value: await pendingReceipt(body) }, ...steps);
	const response = await request(
		`/api/v1/sync/operations/${OPERATION_ID}`,
		jsonRequest(body),
	);
	d1.expectConsumed();
	return { response, d1 };
};

describe('Setup sync operations', () => {
	test('validates all three strict setup operation contracts', () => {
		expect(setupCreateSyncCommandInput.safeParse(createCommand()).success).toBe(
			true,
		);
		expect(
			setupCorrectSyncCommandInput.safeParse(correctCommand()).success,
		).toBe(true);
		expect(
			setupSelectCurrentSyncCommandInput.safeParse(selectCommand()).success,
		).toBe(true);
		expect(
			setupCreateSyncCommandInput.safeParse({
				...createCommand(),
				unexpected: true,
			}).success,
		).toBe(false);
	});

	test('creates a client-identified immutable Setup without changing Current', async () => {
		const command = createCommand();
		const body = requestBody(command);
		const expected = {
			operationId: OPERATION_ID,
			outcome: 'applied',
			setup: expect.objectContaining({
				id: SETUP_ID,
				name: 'Clay baseline',
				version: 1,
			}),
			currentSetupId: SOURCE_ID,
			currentSetupVersion: 2,
		};
		const stored = {
			...expected,
			setup: {
				...setupRow({ lastOperationId: OPERATION_ID }),
				current: false,
			},
		};
		const response = {
			operationId: OPERATION_ID,
			outcome: 'applied',
			setup: {
				id: SETUP_ID,
				carId: CAR_ID,
				name: 'Clay baseline',
				status: 'active',
				current: false,
				context: {
					recordedAt: null,
					track: 'Home track',
					event: null,
					surface: null,
					traction: null,
					moisture: null,
					condition: null,
					temperature: null,
				},
				sections: {
					vehicle: {},
					drivetrain: {},
					electronics: {},
					tires: {},
					shocks: {},
					frontSuspension: {},
					rearSuspension: {},
					notes: {},
				},
				tires: null,
				notes: null,
				source: {
					url: null,
					pdfUrl: null,
					pdfTitle: null,
					pdfPage: null,
					metadata: null,
				},
				copiedFromSetupId: null,
				rawValues: null,
				unmappedValues: null,
				createdAt: expect.any(String),
				updatedAt: expect.any(String),
				version: 1,
			},
			currentSetupId: SOURCE_ID,
			currentSetupVersion: 2,
		};
		const terminal = {
			...response,
			setup: {
				...response.setup,
				createdAt: '2026-08-11T00:00:00.000Z',
				updatedAt: '2026-08-11T00:00:00.000Z',
			},
		};
		const result = await apply(command, [
			{ kind: 'first', value: carRow() },
			{ kind: 'first', value: null },
			{ kind: 'batch' },
			{ kind: 'first', value: await terminalReceipt(body, 200, terminal) },
		]);
		expect(result.response.status).toBe(200);
		expect(await result.response.json()).toEqual(response);
		expect(stored.setup.id).toBe(SETUP_ID);
	});

	test('creates a copied Setup and advances the versioned Current selection', async () => {
		const command = createCommand({
			copiedFromSetupId: SOURCE_ID,
			makeCurrent: true,
			baseCurrent: { setupId: null, version: 0 },
		});
		const body = requestBody(command);
		const response = {
			operationId: OPERATION_ID,
			outcome: 'applied',
			setup: expect.any(Object),
			currentSetupId: SETUP_ID,
			currentSetupVersion: 1,
		};
		const terminal = {
			operationId: OPERATION_ID,
			outcome: 'applied',
			setup: { id: SETUP_ID },
			currentSetupId: SETUP_ID,
			currentSetupVersion: 1,
		};
		const result = await apply(command, [
			{
				kind: 'first',
				value: carRow({ currentSetupId: null, currentSetupVersion: 0 }),
			},
			{ kind: 'first', value: null },
			{ kind: 'first', value: setupRow({ id: SOURCE_ID }) },
			{ kind: 'batch' },
			{ kind: 'first', value: await terminalReceipt(body, 200, terminal) },
		]);
		expect(result.response.status).toBe(200);
		expect(await result.response.json()).toMatchObject(response);
		expect(result.d1.batches[0]).toHaveLength(3);
	});

	test.each([
		[
			'needs a Current base when selecting the new Setup',
			createCommand({ makeCurrent: true }),
		],
		[
			'rejects a Current base when it is not selecting the new Setup',
			createCommand({
				baseCurrent: { setupId: SOURCE_ID, version: 2 },
			}),
		],
	])('%s', async (_label, command) => {
		const body = requestBody(command);
		const response = {
			operationId: OPERATION_ID,
			outcome: 'rejected',
			error: expect.objectContaining({ code: 'SETUP_VALIDATION_FAILED' }),
		};
		const terminal = {
			operationId: OPERATION_ID,
			outcome: 'rejected',
			error: {
				code: 'SETUP_VALIDATION_FAILED',
				message: 'Setup change needs attention',
			},
		};
		const result = await apply(command, [
			{ kind: 'first', value: carRow() },
			{ kind: 'run' },
			{ kind: 'first', value: await terminalReceipt(body, 422, terminal) },
		]);
		expect(result.response.status).toBe(422);
		expect(await result.response.json()).toMatchObject(response);
	});

	test('rejects invalid Setup commands, missing Cars, and archived Cars', async () => {
		for (const [command, carValue, status, code] of [
			[
				{ ...createCommand(), setup: {} },
				carRow(),
				422,
				'SETUP_VALIDATION_FAILED',
			],
			[createCommand(), null, 404, 'CAR_NOT_FOUND'],
			[
				createCommand(),
				carRow({ archivedAt: '2026-08-10T12:00:00.000Z' }),
				409,
				'CAR_ARCHIVED',
			],
		] as const) {
			const body = requestBody(command);
			const terminal = {
				operationId: OPERATION_ID,
				outcome: 'rejected',
				error: { code, message: 'Rejected' },
			};
			const result = await apply(command, [
				{ kind: 'first', value: carValue },
				{ kind: 'run' },
				{ kind: 'first', value: await terminalReceipt(body, status, terminal) },
			]);
			expect(result.response.status).toBe(status);
			expect(await result.response.json()).toMatchObject({
				outcome: 'rejected',
				error: { code },
			});
		}
	});

	test('keeps a local create as a conflict when Current changed', async () => {
		const command = createCommand({
			makeCurrent: true,
			baseCurrent: { setupId: null, version: 0 },
		});
		const body = requestBody(command);
		const terminal = {
			operationId: OPERATION_ID,
			outcome: 'conflict',
			error: {
				code: 'SETUP_VERSION_CONFLICT',
				message: 'The Current setup changed after this operation was queued',
			},
			remote: {
				currentSetupId: SOURCE_ID,
				currentSetupVersion: 2,
				setup: { id: SOURCE_ID },
			},
		};
		const result = await apply(command, [
			{ kind: 'first', value: carRow() },
			{ kind: 'first', value: null },
			{ kind: 'first', value: setupRow({ id: SOURCE_ID }) },
			{ kind: 'run' },
			{ kind: 'first', value: await terminalReceipt(body, 409, terminal) },
		]);
		expect(result.response.status).toBe(409);
		expect(await result.response.json()).toMatchObject({
			outcome: 'conflict',
			remote: { currentSetupId: SOURCE_ID, currentSetupVersion: 2 },
		});
	});

	test('rejects a create whose copy source no longer exists', async () => {
		const command = createCommand({ copiedFromSetupId: SOURCE_ID });
		const body = requestBody(command);
		const terminal = {
			operationId: OPERATION_ID,
			outcome: 'rejected',
			error: { code: 'SETUP_NOT_FOUND', message: 'Source setup not found' },
		};
		const result = await apply(command, [
			{ kind: 'first', value: carRow() },
			{ kind: 'first', value: null },
			{ kind: 'first', value: null },
			{ kind: 'run' },
			{ kind: 'first', value: await terminalReceipt(body, 404, terminal) },
		]);
		expect(result.response.status).toBe(404);
	});

	test('reconstructs an applied create after a receipt interruption', async () => {
		const command = createCommand();
		const body = requestBody(command);
		const existing = setupRow({ lastOperationId: OPERATION_ID });
		const terminal = {
			operationId: OPERATION_ID,
			outcome: 'applied',
			setup: { id: SETUP_ID },
			currentSetupId: SOURCE_ID,
			currentSetupVersion: 2,
		};
		const result = await apply(command, [
			{ kind: 'first', value: carRow() },
			{ kind: 'first', value: existing },
			{ kind: 'run' },
			{ kind: 'first', value: await terminalReceipt(body, 200, terminal) },
		]);
		expect(result.response.status).toBe(200);
	});

	test.each([
		[
			'existing identity',
			setupRow({ lastOperationId: 'another-operation' }),
			carRow({ currentSetupId: null, currentSetupVersion: 0 }),
		],
		[
			'interrupted Current selection',
			setupRow({ lastOperationId: OPERATION_ID }),
			carRow({ currentSetupOperationId: 'another-operation' }),
		],
		[
			'identity owned by another Car',
			setupRow({
				carId: '50000000-0000-4000-8000-000000000001',
				lastOperationId: 'another-operation',
			}),
			carRow({ currentSetupId: null, currentSetupVersion: 0 }),
		],
	])('conflicts after an %s collision', async (_label, existing, parent) => {
		const command = createCommand({
			makeCurrent: _label === 'interrupted Current selection',
			baseCurrent:
				_label === 'interrupted Current selection'
					? { setupId: SOURCE_ID, version: 2 }
					: null,
		});
		const body = requestBody(command);
		const terminal = {
			operationId: OPERATION_ID,
			outcome: 'conflict',
			error: { code: 'SETUP_VERSION_CONFLICT', message: 'Conflict' },
			remote: {
				currentSetupId: parent.currentSetupId,
				currentSetupVersion: parent.currentSetupVersion,
				setup: { id: SETUP_ID },
			},
		};
		const currentRead = parent.currentSetupId
			? [{ kind: 'first', value: setupRow({ id: SOURCE_ID }) } as const]
			: [];
		const result = await apply(command, [
			{ kind: 'first', value: parent },
			{ kind: 'first', value: existing },
			...currentRead,
			{ kind: 'run' },
			{ kind: 'first', value: await terminalReceipt(body, 409, terminal) },
		]);
		expect(result.response.status).toBe(409);
	});

	test('merges a non-overlapping correction and advances only the Setup version', async () => {
		const command = correctCommand({
			baseVersion: 0,
			base: { track: 'Home track', setupDate: null, notes: null },
			changes: {
				track: 'Away track',
				setupDate: '2026-08-11T10:00:00.000Z',
				notes: 'Raised rear link',
			},
		});
		const body = requestBody(command);
		const terminal = {
			operationId: OPERATION_ID,
			outcome: 'applied',
			setup: { id: SETUP_ID, version: 2 },
			currentSetupId: SOURCE_ID,
			currentSetupVersion: 2,
		};
		const result = await apply(command, [
			{ kind: 'first', value: carRow() },
			{ kind: 'first', value: setupRow({ version: 1 }) },
			{ kind: 'batch' },
			{ kind: 'first', value: await terminalReceipt(body, 200, terminal) },
		]);
		expect(result.response.status).toBe(200);
		expect(await result.response.json()).toMatchObject(terminal);
	});

	test('compares nested correction bases canonically before merging', async () => {
		const command = correctCommand({
			base: { vehicle: { weight: 1500, links: [1, 2] } },
			changes: { vehicle: { weight: 1490, links: [1, 2] } },
		});
		const body = requestBody(command);
		const terminal = {
			operationId: OPERATION_ID,
			outcome: 'applied',
			setup: { id: SETUP_ID, version: 2 },
			currentSetupId: SOURCE_ID,
			currentSetupVersion: 2,
		};
		const result = await apply(command, [
			{ kind: 'first', value: carRow() },
			{
				kind: 'first',
				value: setupRow({ vehicle: '{"links":[1,2],"weight":1500}' }),
			},
			{ kind: 'batch' },
			{ kind: 'first', value: await terminalReceipt(body, 200, terminal) },
		]);
		expect(result.response.status).toBe(200);
	});

	test('corrects a recorded Setup date back to an unrecorded value', async () => {
		const recordedAt = '2026-08-10T08:00:00.000Z';
		const command = correctCommand({
			base: { setupDate: recordedAt },
			changes: { setupDate: null },
		});
		const body = requestBody(command);
		const terminal = {
			operationId: OPERATION_ID,
			outcome: 'applied',
			setup: { id: SETUP_ID, version: 2 },
			currentSetupId: SOURCE_ID,
			currentSetupVersion: 2,
		};
		const result = await apply(command, [
			{ kind: 'first', value: carRow() },
			{ kind: 'first', value: setupRow({ setupDate: recordedAt }) },
			{ kind: 'batch' },
			{ kind: 'first', value: await terminalReceipt(body, 200, terminal) },
		]);
		expect(result.response.status).toBe(200);
	});

	test.each([
		['invalid command', { ...correctCommand(), changes: [] }, undefined, 422],
		[
			'mismatched base fields',
			correctCommand({ base: { name: 'Clay baseline' } }),
			undefined,
			422,
		],
		[
			'unknown changed fields',
			correctCommand({ base: { bogus: null }, changes: { bogus: 'value' } }),
			undefined,
			422,
		],
		['missing Setup', correctCommand(), null, 404],
	])(
		'rejects correction with %s',
		async (_label, command, existing, status) => {
			const body = requestBody(command);
			const terminal = {
				operationId: OPERATION_ID,
				outcome: 'rejected',
				error: {
					code: status === 404 ? 'SETUP_NOT_FOUND' : 'SETUP_VALIDATION_FAILED',
					message: 'Rejected',
				},
			};
			const setupRead =
				existing === undefined && status === 422
					? []
					: [{ kind: 'first', value: existing } as const];
			const result = await apply(command, [
				{ kind: 'first', value: carRow() },
				...setupRead,
				{ kind: 'run' },
				{ kind: 'first', value: await terminalReceipt(body, status, terminal) },
			]);
			expect(result.response.status).toBe(status);
		},
	);

	test('retains both versions when a correction overlaps a remote change', async () => {
		const command = correctCommand();
		const body = requestBody(command);
		const terminal = {
			operationId: OPERATION_ID,
			outcome: 'conflict',
			error: { code: 'SETUP_VERSION_CONFLICT', message: 'Conflict' },
			remote: {
				currentSetupId: SOURCE_ID,
				currentSetupVersion: 2,
				setup: { id: SETUP_ID, track: 'Remote track' },
			},
		};
		const result = await apply(command, [
			{ kind: 'first', value: carRow() },
			{ kind: 'first', value: setupRow({ track: 'Remote track', version: 2 }) },
			{ kind: 'first', value: setupRow({ id: SOURCE_ID }) },
			{ kind: 'run' },
			{ kind: 'first', value: await terminalReceipt(body, 409, terminal) },
		]);
		expect(result.response.status).toBe(409);
		expect(await result.response.json()).toMatchObject({
			outcome: 'conflict',
			remote: { setup: { id: SETUP_ID } },
		});
	});

	test('selects Current with a compare-and-swap and advances its version', async () => {
		const command = selectCommand();
		const body = requestBody(command);
		const terminal = {
			operationId: OPERATION_ID,
			outcome: 'applied',
			setup: { id: SETUP_ID },
			currentSetupId: SETUP_ID,
			currentSetupVersion: 3,
		};
		const result = await apply(command, [
			{ kind: 'first', value: carRow() },
			{ kind: 'first', value: setupRow() },
			{ kind: 'batch' },
			{ kind: 'first', value: await terminalReceipt(body, 200, terminal) },
		]);
		expect(result.response.status).toBe(200);
		expect(result.d1.batches[0]).toHaveLength(2);
	});

	test('treats selecting the existing Current Setup as idempotent', async () => {
		const command = selectCommand({
			baseCurrent: { setupId: SETUP_ID, version: 2 },
		});
		const body = requestBody(command);
		const terminal = {
			operationId: OPERATION_ID,
			outcome: 'applied',
			setup: { id: SETUP_ID },
			currentSetupId: SETUP_ID,
			currentSetupVersion: 2,
		};
		const result = await apply(command, [
			{ kind: 'first', value: carRow({ currentSetupId: SETUP_ID }) },
			{ kind: 'first', value: setupRow() },
			{ kind: 'run' },
			{ kind: 'first', value: await terminalReceipt(body, 200, terminal) },
		]);
		expect(result.response.status).toBe(200);
	});

	test.each([
		['invalid selection', { ...selectCommand(), baseCurrent: null }, 422],
		['missing Setup', selectCommand(), 404],
	])('rejects %s', async (_label, command, status) => {
		const body = requestBody(command);
		const terminal = {
			operationId: OPERATION_ID,
			outcome: 'rejected',
			error: {
				code: status === 404 ? 'SETUP_NOT_FOUND' : 'SETUP_VALIDATION_FAILED',
				message: 'Rejected',
			},
		};
		const setupRead =
			status === 404 ? [{ kind: 'first', value: null } as const] : [];
		const result = await apply(command, [
			{ kind: 'first', value: carRow() },
			...setupRead,
			{ kind: 'run' },
			{ kind: 'first', value: await terminalReceipt(body, status, terminal) },
		]);
		expect(result.response.status).toBe(status);
	});

	test('retains local selection when the server Current selection changed', async () => {
		const command = selectCommand({
			baseCurrent: { setupId: null, version: 0 },
		});
		const body = requestBody(command);
		const terminal = {
			operationId: OPERATION_ID,
			outcome: 'conflict',
			error: { code: 'SETUP_VERSION_CONFLICT', message: 'Conflict' },
			remote: {
				currentSetupId: SOURCE_ID,
				currentSetupVersion: 2,
				setup: { id: SOURCE_ID },
			},
		};
		const result = await apply(command, [
			{ kind: 'first', value: carRow() },
			{ kind: 'first', value: setupRow() },
			{ kind: 'first', value: setupRow({ id: SOURCE_ID }) },
			{ kind: 'run' },
			{ kind: 'first', value: await terminalReceipt(body, 409, terminal) },
		]);
		expect(result.response.status).toBe(409);
	});
});
