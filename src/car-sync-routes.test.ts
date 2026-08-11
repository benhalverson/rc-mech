import { describe, expect, test } from 'vitest';
import { createHonoFixture } from './testing/hono-fixture';
import { carEditSyncCommandInput } from './types';

const OPERATION_ID = '10000000-0000-4000-8000-000000000001';
const CAR_ID = '20000000-0000-4000-8000-000000000001';
const CREATE_REQUEST_HASH =
	'c85b7e8463607fb7843c35501db87fa20aa9094a5c0c07a033dbb8edc358fcbb';
const INVALID_CREATE_REQUEST_HASH =
	'4f496e833d81e61e26408a04ba1b65e2cc0db688ab2f0eb4cb0ca70cbbdb14ad';
const EDIT_REQUEST_HASH =
	'b5cdd80f99d7b4bc40062af52c0bd0fdd7c68112c0aa031d765b2915a0a54eb0';
const ARCHIVE_REQUEST_HASH =
	'1ee9c1e14687836f4af6e87a9a8fa37128e08ccdb7c2116b5aa6339d0facfc4a';
const RESTORE_REQUEST_HASH =
	'8e4bb7d986b4d81fb0237bc50347c63691d778d274e8a7d1248ec9b45292b628';
const INVALID_EDIT_BASE_REQUEST_HASH =
	'84281c552cd7f16439381b585caf3c21f175784d4ab228144dca1bbd9a52d545';
const UNSUPPORTED_REQUEST_HASH =
	'8c7c70182250e8b1028155176e62cb056c947f2775e183dbe49dbca638e245ef';
const INVALID_EDIT_CHANGES_REQUEST_HASH =
	'6c60a0ef7486bc08f5317cc807d47094afeca83e2d4ac53246418531b20cc758';
const INVALID_EDIT_STRUCTURE_REQUEST_HASH =
	'a0addccf48bda796802391abff7c7da20828ddff4593d94250cfe38a1d18b32c';
const INVALID_LIFECYCLE_REQUEST_HASH =
	'3806759f2b4f4776c5804d52af28031577e456ced8b62a98262f852dc539b46d';
const INVALID_ARRAY_REQUEST_HASH =
	'747e6f2725d72df3de30c1b988d4f9c9e257474f655371d667f74d8ec7c2e6fc';
const REQUIRED_CREATE_REQUEST_HASH =
	'5252e9597e547f1cffa57791ff9c4c3a15596665bfebfb053469d75bbfd85b5f';

const createCommand = {
	contractVersion: 1,
	command: {
		type: 'car.create',
		carId: CAR_ID,
		car: { name: 'B7 carpet', make: 'Associated' },
	},
} as const;

const jsonRequest = (body: unknown): RequestInit => ({
	method: 'PUT',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body),
});

const carRow = (
	overrides: Partial<{
		ownerId: string;
		name: string;
		make: string | null;
		archivedAt: string | null;
		version: number;
		lastOperationId: string | null;
	}> = {},
) => ({
	id: CAR_ID,
	ownerId: 'owner-1',
	name: 'B7 carpet',
	make: 'Team Associated',
	model: 'B7',
	scale: '1/10',
	vehicleType: 'buggy',
	powerType: 'electric',
	notes: null,
	currentSetupId: null,
	createdAt: '2026-08-10T00:00:00.000Z',
	archivedAt: null,
	version: 2,
	lastOperationId: 'remote-operation',
	...overrides,
});

const appliedReceipt = (
	kind: 'car.create' | 'car.edit' | 'car.archive' | 'car.restore',
	requestHash: string,
	response: unknown,
) => ({
	ownerId: 'owner-1',
	operationId: OPERATION_ID,
	contractVersion: 1,
	kind,
	entityType: 'car',
	entityId: CAR_ID,
	requestHash,
	outcome: 'applied',
	httpStatus: 200,
	responseJson: JSON.stringify(response),
	createdAt: '2026-08-11T00:00:00.000Z',
	completedAt: '2026-08-11T00:00:00.000Z',
});

const pendingReceipt = (
	kind: 'car.create' | 'car.edit' | 'car.archive' | 'car.restore',
	requestHash: string,
	overrides: Record<string, unknown> = {},
) => ({
	ownerId: 'owner-1',
	operationId: OPERATION_ID,
	contractVersion: 1,
	kind,
	entityType: 'car',
	entityId: CAR_ID,
	requestHash,
	outcome: 'pending',
	httpStatus: null,
	responseJson: null,
	createdAt: '2026-08-11T00:00:00.000Z',
	completedAt: null,
	...overrides,
});

const terminalReceipt = (
	kind: 'car.create' | 'car.edit' | 'car.archive' | 'car.restore',
	requestHash: string,
	httpStatus: number,
	response: Readonly<{ outcome: 'applied' | 'rejected' | 'conflict' }>,
) => ({
	...pendingReceipt(kind, requestHash),
	outcome: response.outcome,
	httpStatus,
	responseJson: JSON.stringify(response),
	completedAt: '2026-08-11T00:00:00.000Z',
});

describe('Car sync operations', () => {
	test('accepts a zero base version for an edit queued behind local creation', () => {
		expect(
			carEditSyncCommandInput.safeParse({
				type: 'car.edit',
				carId: CAR_ID,
				baseVersion: 0,
				base: { name: 'Local Car' },
				changes: { name: 'Local Car renamed' },
			}).success,
		).toBe(true);
	});
	test('durably applies a client-identified Car creation for the authenticated User', async () => {
		const { d1, request } = createHonoFixture();
		d1.queue(
			{
				kind: 'first',
				value: {
					ownerId: 'owner-1',
					operationId: OPERATION_ID,
					contractVersion: 1,
					kind: 'car.create',
					entityType: 'car',
					entityId: CAR_ID,
					requestHash: CREATE_REQUEST_HASH,
					outcome: 'pending',
					httpStatus: null,
					responseJson: null,
					createdAt: '2026-08-11T00:00:00.000Z',
					completedAt: null,
				},
			},
			{ kind: 'batch' },
			{
				kind: 'first',
				value: appliedReceipt('car.create', CREATE_REQUEST_HASH, {
					operationId: OPERATION_ID,
					outcome: 'applied',
					car: {
						id: CAR_ID,
						name: 'B7 carpet',
						make: 'Associated',
						model: null,
						scale: null,
						vehicleType: null,
						powerType: null,
						notes: null,
						currentSetupId: null,
						createdAt: '2026-08-11T00:00:00.000Z',
						archivedAt: null,
						version: 1,
					},
				}),
			},
		);

		const response = await request(
			`/api/v1/sync/operations/${OPERATION_ID}`,
			jsonRequest(createCommand),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			operationId: OPERATION_ID,
			outcome: 'applied',
			car: {
				id: CAR_ID,
				name: 'B7 carpet',
				make: 'Associated',
				model: null,
				scale: null,
				vehicleType: null,
				powerType: null,
				notes: null,
				currentSetupId: null,
				createdAt: expect.any(String),
				archivedAt: null,
				version: 1,
			},
		});
		d1.expectConsumed();
	});

	test('replays an exact terminal response without writing the Car again', async () => {
		const { d1, request } = createHonoFixture();
		const storedResponse = {
			operationId: OPERATION_ID,
			outcome: 'applied',
			car: {
				id: CAR_ID,
				name: 'B7 carpet',
				make: 'Associated',
				model: null,
				scale: null,
				vehicleType: null,
				powerType: null,
				notes: null,
				currentSetupId: null,
				createdAt: '2026-08-11T00:00:00.000Z',
				archivedAt: null,
				version: 1,
			},
		};
		d1.queue(
			{ kind: 'first', value: null },
			{
				kind: 'first',
				value: {
					ownerId: 'owner-1',
					operationId: OPERATION_ID,
					contractVersion: 1,
					kind: 'car.create',
					entityType: 'car',
					entityId: CAR_ID,
					requestHash: CREATE_REQUEST_HASH,
					outcome: 'applied',
					httpStatus: 200,
					responseJson: JSON.stringify(storedResponse),
					createdAt: '2026-08-11T00:00:00.000Z',
					completedAt: '2026-08-11T00:00:00.000Z',
				},
			},
		);

		const response = await request(
			`/api/v1/sync/operations/${OPERATION_ID}`,
			jsonRequest({
				command: {
					car: { make: 'Associated', name: 'B7 carpet' },
					carId: CAR_ID,
					type: 'car.create',
				},
				contractVersion: 1,
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(JSON.stringify(storedResponse));
		expect(d1.batches).toEqual([]);
		d1.expectConsumed();
	});

	test('rejects operation-ID reuse with a different request without exposing the prior result', async () => {
		const { d1, request } = createHonoFixture();
		d1.queue(
			{ kind: 'first', value: null },
			{
				kind: 'first',
				value: {
					ownerId: 'owner-1',
					operationId: OPERATION_ID,
					contractVersion: 1,
					kind: 'car.create',
					entityType: 'car',
					entityId: CAR_ID,
					requestHash: CREATE_REQUEST_HASH,
					outcome: 'applied',
					httpStatus: 200,
					responseJson: '{"private":"must not leak"}',
					createdAt: '2026-08-11T00:00:00.000Z',
					completedAt: '2026-08-11T00:00:00.000Z',
				},
			},
		);

		const response = await request(
			`/api/v1/sync/operations/${OPERATION_ID}`,
			jsonRequest({
				...createCommand,
				command: {
					...createCommand.command,
					car: { name: 'Different Car' },
				},
			}),
		);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: {
				code: 'OPERATION_ID_REUSED',
				message: 'Operation ID was already used for another request',
			},
		});
		expect(d1.batches).toEqual([]);
		d1.expectConsumed();
	});

	test('durably retains canonical Car validation feedback for exact retry', async () => {
		const { d1, request } = createHonoFixture();
		const invalidCommand = {
			contractVersion: 1,
			command: {
				type: 'car.create',
				carId: CAR_ID,
				car: { name: '' },
			},
		} as const;
		const rejection = {
			operationId: OPERATION_ID,
			outcome: 'rejected',
			error: {
				code: 'CAR_VALIDATION_FAILED',
				message: 'Car change needs attention',
				details: {
					formErrors: [],
					fieldErrors: {
						name: ['Too small: expected string to have >=1 characters'],
					},
				},
			},
		};
		const pendingReceipt = {
			ownerId: 'owner-1',
			operationId: OPERATION_ID,
			contractVersion: 1,
			kind: 'car.create',
			entityType: 'car',
			entityId: CAR_ID,
			requestHash: INVALID_CREATE_REQUEST_HASH,
			outcome: 'pending',
			httpStatus: null,
			responseJson: null,
			createdAt: '2026-08-11T00:00:00.000Z',
			completedAt: null,
		};
		d1.queue(
			{ kind: 'first', value: pendingReceipt },
			{ kind: 'run' },
			{ kind: 'first', value: null },
			{
				kind: 'first',
				value: {
					...pendingReceipt,
					outcome: 'rejected',
					httpStatus: 422,
					responseJson: JSON.stringify(rejection),
					completedAt: '2026-08-11T00:00:00.000Z',
				},
			},
		);

		const first = await request(
			`/api/v1/sync/operations/${OPERATION_ID}`,
			jsonRequest(invalidCommand),
		);
		const retry = await request(
			`/api/v1/sync/operations/${OPERATION_ID}`,
			jsonRequest(invalidCommand),
		);

		expect(first.status).toBe(422);
		expect(await first.json()).toEqual(rejection);
		expect(retry.status).toBe(422);
		expect(await retry.json()).toEqual(rejection);
		expect(d1.batches).toEqual([]);
		d1.expectConsumed();
	});

	test('merges a stale edit when the changed field still matches its base value', async () => {
		const { d1, request } = createHonoFixture();
		const editCommand = {
			contractVersion: 1,
			command: {
				type: 'car.edit',
				carId: CAR_ID,
				baseVersion: 1,
				base: { name: 'B7 carpet' },
				changes: { name: 'B7 carpet club setup' },
			},
		} as const;
		d1.queue(
			{
				kind: 'first',
				value: {
					ownerId: 'owner-1',
					operationId: OPERATION_ID,
					contractVersion: 1,
					kind: 'car.edit',
					entityType: 'car',
					entityId: CAR_ID,
					requestHash: EDIT_REQUEST_HASH,
					outcome: 'pending',
					httpStatus: null,
					responseJson: null,
					createdAt: '2026-08-11T00:00:00.000Z',
					completedAt: null,
				},
			},
			{ kind: 'first', value: carRow() },
			{ kind: 'batch' },
			{
				kind: 'first',
				value: appliedReceipt('car.edit', EDIT_REQUEST_HASH, {
					operationId: OPERATION_ID,
					outcome: 'applied',
					car: {
						id: CAR_ID,
						name: 'B7 carpet club setup',
						make: 'Team Associated',
						model: 'B7',
						scale: '1/10',
						vehicleType: 'buggy',
						powerType: 'electric',
						notes: null,
						currentSetupId: null,
						createdAt: '2026-08-10T00:00:00.000Z',
						archivedAt: null,
						version: 3,
					},
				}),
			},
		);

		const response = await request(
			`/api/v1/sync/operations/${OPERATION_ID}`,
			jsonRequest(editCommand),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			operationId: OPERATION_ID,
			outcome: 'applied',
			car: {
				id: CAR_ID,
				name: 'B7 carpet club setup',
				make: 'Team Associated',
				model: 'B7',
				scale: '1/10',
				vehicleType: 'buggy',
				powerType: 'electric',
				notes: null,
				currentSetupId: null,
				createdAt: '2026-08-10T00:00:00.000Z',
				archivedAt: null,
				version: 3,
			},
		});
		d1.expectConsumed();
	});

	test('retains both local and owner-safe remote Cars when an edited field changed remotely', async () => {
		const { d1, request } = createHonoFixture();
		const command = {
			type: 'car.edit',
			carId: CAR_ID,
			baseVersion: 1,
			base: { name: 'B7 carpet' },
			changes: { name: 'B7 carpet club setup' },
		} as const;
		const conflictResponse = {
			operationId: OPERATION_ID,
			outcome: 'conflict' as const,
			error: {
				code: 'CAR_VERSION_CONFLICT',
				message: 'The Car changed after this operation was queued',
			},
			local: { baseVersion: 1, command },
			remote: {
				car: {
					id: CAR_ID,
					name: 'Remote name',
					make: 'Team Associated',
					model: 'B7',
					scale: '1/10',
					vehicleType: 'buggy',
					powerType: 'electric',
					notes: null,
					currentSetupId: null,
					createdAt: '2026-08-10T00:00:00.000Z',
					archivedAt: null,
					version: 2,
				},
			},
		};
		d1.queue(
			{
				kind: 'first',
				value: {
					ownerId: 'owner-1',
					operationId: OPERATION_ID,
					contractVersion: 1,
					kind: 'car.edit',
					entityType: 'car',
					entityId: CAR_ID,
					requestHash: EDIT_REQUEST_HASH,
					outcome: 'pending',
					httpStatus: null,
					responseJson: null,
					createdAt: '2026-08-11T00:00:00.000Z',
					completedAt: null,
				},
			},
			{ kind: 'first', value: carRow({ name: 'Remote name' }) },
			{ kind: 'run' },
			{
				kind: 'first',
				value: terminalReceipt(
					'car.edit',
					EDIT_REQUEST_HASH,
					409,
					conflictResponse,
				),
			},
		);

		const response = await request(
			`/api/v1/sync/operations/${OPERATION_ID}`,
			jsonRequest({ contractVersion: 1, command }),
		);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual(conflictResponse);
		expect(d1.batches).toEqual([]);
		d1.expectConsumed();
	});

	test('returns the durable applied receipt when an identical retry observes its completed write', async () => {
		const appliedResponse = {
			operationId: OPERATION_ID,
			outcome: 'applied' as const,
			car: {
				id: CAR_ID,
				name: 'B7 carpet club setup',
				make: 'Team Associated',
				model: 'B7',
				scale: '1/10',
				vehicleType: 'buggy',
				powerType: 'electric',
				notes: null,
				currentSetupId: null,
				createdAt: '2026-08-10T00:00:00.000Z',
				archivedAt: null,
				version: 3,
			},
		};
		const { d1, request } = createHonoFixture();
		d1.queue(
			{ kind: 'first', value: pendingReceipt('car.edit', EDIT_REQUEST_HASH) },
			{
				kind: 'first',
				value: carRow({
					name: 'B7 carpet club setup',
					version: 3,
					lastOperationId: OPERATION_ID,
				}),
			},
			{ kind: 'run' },
			{
				kind: 'first',
				value: terminalReceipt(
					'car.edit',
					EDIT_REQUEST_HASH,
					200,
					appliedResponse,
				),
			},
		);

		const response = await request(
			`/api/v1/sync/operations/${OPERATION_ID}`,
			jsonRequest({
				contractVersion: 1,
				command: {
					type: 'car.edit',
					carId: CAR_ID,
					baseVersion: 1,
					base: { name: 'B7 carpet' },
					changes: { name: 'B7 carpet club setup' },
				},
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(appliedResponse);
		d1.expectConsumed();
	});

	test.each([
		['missing', null],
		['unowned', carRow({ ownerId: 'owner-2' })],
	] as const)(
		'rejects a %s edit through the same owner-safe contract',
		async (_label, selectedCar) => {
			const { d1, request } = createHonoFixture();
			d1.queue(
				{
					kind: 'first',
					value: {
						ownerId: 'owner-1',
						operationId: OPERATION_ID,
						contractVersion: 1,
						kind: 'car.edit',
						entityType: 'car',
						entityId: CAR_ID,
						requestHash: EDIT_REQUEST_HASH,
						outcome: 'pending',
						httpStatus: null,
						responseJson: null,
						createdAt: '2026-08-11T00:00:00.000Z',
						completedAt: null,
					},
				},
				{ kind: 'first', value: selectedCar },
				{ kind: 'run' },
			);

			const response = await request(
				`/api/v1/sync/operations/${OPERATION_ID}`,
				jsonRequest({
					contractVersion: 1,
					command: {
						type: 'car.edit',
						carId: CAR_ID,
						baseVersion: 1,
						base: { name: 'B7 carpet' },
						changes: { name: 'B7 carpet club setup' },
					},
				}),
			);

			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({
				operationId: OPERATION_ID,
				outcome: 'rejected',
				error: { code: 'CAR_NOT_FOUND', message: 'Car not found' },
			});
			d1.expectConsumed();
		},
	);

	test('archives over a descriptive edit and pauses maintenance in the atomic application', async () => {
		const { d1, request } = createHonoFixture();
		d1.queue(
			{
				kind: 'first',
				value: {
					ownerId: 'owner-1',
					operationId: OPERATION_ID,
					contractVersion: 1,
					kind: 'car.archive',
					entityType: 'car',
					entityId: CAR_ID,
					requestHash: ARCHIVE_REQUEST_HASH,
					outcome: 'pending',
					httpStatus: null,
					responseJson: null,
					createdAt: '2026-08-11T00:00:00.000Z',
					completedAt: null,
				},
			},
			{ kind: 'first', value: carRow({ name: 'Remote descriptive edit' }) },
			{ kind: 'batch' },
			{
				kind: 'first',
				value: appliedReceipt('car.archive', ARCHIVE_REQUEST_HASH, {
					operationId: OPERATION_ID,
					outcome: 'applied',
					car: {
						id: CAR_ID,
						name: 'Remote descriptive edit',
						make: 'Team Associated',
						model: 'B7',
						scale: '1/10',
						vehicleType: 'buggy',
						powerType: 'electric',
						notes: null,
						currentSetupId: null,
						createdAt: '2026-08-10T00:00:00.000Z',
						archivedAt: '2026-08-11T12:00:00.000Z',
						version: 3,
					},
				}),
			},
		);

		const response = await request(
			`/api/v1/sync/operations/${OPERATION_ID}`,
			jsonRequest({
				contractVersion: 1,
				command: {
					type: 'car.archive',
					carId: CAR_ID,
					baseVersion: 1,
					base: { archivedAt: null },
				},
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			operationId: OPERATION_ID,
			outcome: 'applied',
			car: {
				id: CAR_ID,
				name: 'Remote descriptive edit',
				make: 'Team Associated',
				model: 'B7',
				scale: '1/10',
				vehicleType: 'buggy',
				powerType: 'electric',
				notes: null,
				currentSetupId: null,
				createdAt: '2026-08-10T00:00:00.000Z',
				archivedAt: expect.any(String),
				version: 3,
			},
		});
		expect(d1.batches[0]).toHaveLength(3);
		expect(d1.batches[0]?.join(' ')).toContain('maintenance_plan');
		d1.expectConsumed();
	});

	test('returns a lifecycle Sync conflict when the archived state changed incompatibly', async () => {
		const { d1, request } = createHonoFixture();
		const command = {
			type: 'car.restore',
			carId: CAR_ID,
			baseVersion: 2,
			base: { archivedAt: '2026-08-10T12:00:00.000Z' },
		} as const;
		const conflictResponse = {
			operationId: OPERATION_ID,
			outcome: 'conflict' as const,
			error: {
				code: 'CAR_VERSION_CONFLICT',
				message: 'The Car changed after this operation was queued',
			},
			local: { baseVersion: 2, command },
			remote: {
				car: {
					id: CAR_ID,
					name: 'B7 carpet',
					make: 'Team Associated',
					model: 'B7',
					scale: '1/10',
					vehicleType: 'buggy',
					powerType: 'electric',
					notes: null,
					currentSetupId: null,
					createdAt: '2026-08-10T00:00:00.000Z',
					archivedAt: '2026-08-11T12:00:00.000Z',
					version: 2,
				},
			},
		};
		d1.queue(
			{
				kind: 'first',
				value: {
					ownerId: 'owner-1',
					operationId: OPERATION_ID,
					contractVersion: 1,
					kind: 'car.restore',
					entityType: 'car',
					entityId: CAR_ID,
					requestHash: RESTORE_REQUEST_HASH,
					outcome: 'pending',
					httpStatus: null,
					responseJson: null,
					createdAt: '2026-08-11T00:00:00.000Z',
					completedAt: null,
				},
			},
			{
				kind: 'first',
				value: carRow({ archivedAt: '2026-08-11T12:00:00.000Z' }),
			},
			{ kind: 'run' },
			{
				kind: 'first',
				value: terminalReceipt(
					'car.restore',
					RESTORE_REQUEST_HASH,
					409,
					conflictResponse,
				),
			},
		);

		const response = await request(
			`/api/v1/sync/operations/${OPERATION_ID}`,
			jsonRequest({ contractVersion: 1, command }),
		);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual(conflictResponse);
		expect(d1.batches).toEqual([]);
		d1.expectConsumed();
	});

	test('acknowledges an already-archived Car without a second lifecycle write', async () => {
		const { d1, request } = createHonoFixture();
		const appliedResponse = {
			operationId: OPERATION_ID,
			outcome: 'applied' as const,
			car: {
				id: CAR_ID,
				name: 'B7 carpet',
				make: 'Team Associated',
				model: 'B7',
				scale: '1/10',
				vehicleType: 'buggy',
				powerType: 'electric',
				notes: null,
				currentSetupId: null,
				createdAt: '2026-08-10T00:00:00.000Z',
				archivedAt: '2026-08-11T12:00:00.000Z',
				version: 2,
			},
		};
		d1.queue(
			{
				kind: 'first',
				value: {
					ownerId: 'owner-1',
					operationId: OPERATION_ID,
					contractVersion: 1,
					kind: 'car.archive',
					entityType: 'car',
					entityId: CAR_ID,
					requestHash: ARCHIVE_REQUEST_HASH,
					outcome: 'pending',
					httpStatus: null,
					responseJson: null,
					createdAt: '2026-08-11T00:00:00.000Z',
					completedAt: null,
				},
			},
			{
				kind: 'first',
				value: carRow({ archivedAt: '2026-08-11T12:00:00.000Z' }),
			},
			{ kind: 'run' },
			{
				kind: 'first',
				value: terminalReceipt(
					'car.archive',
					ARCHIVE_REQUEST_HASH,
					200,
					appliedResponse,
				),
			},
		);

		const response = await request(
			`/api/v1/sync/operations/${OPERATION_ID}`,
			jsonRequest({
				contractVersion: 1,
				command: {
					type: 'car.archive',
					carId: CAR_ID,
					baseVersion: 1,
					base: { archivedAt: null },
				},
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(appliedResponse);
		expect(d1.batches).toEqual([]);
		d1.expectConsumed();
	});

	test('retains an edit whose base fields do not exactly match its changed fields as Needs attention', async () => {
		const { d1, request } = createHonoFixture();
		d1.queue(
			{
				kind: 'first',
				value: {
					ownerId: 'owner-1',
					operationId: OPERATION_ID,
					contractVersion: 1,
					kind: 'car.edit',
					entityType: 'car',
					entityId: CAR_ID,
					requestHash: INVALID_EDIT_BASE_REQUEST_HASH,
					outcome: 'pending',
					httpStatus: null,
					responseJson: null,
					createdAt: '2026-08-11T00:00:00.000Z',
					completedAt: null,
				},
			},
			{ kind: 'run' },
		);

		const response = await request(
			`/api/v1/sync/operations/${OPERATION_ID}`,
			jsonRequest({
				contractVersion: 1,
				command: {
					type: 'car.edit',
					carId: CAR_ID,
					baseVersion: 1,
					base: {},
					changes: { name: 'B7 carpet club setup' },
				},
			}),
		);

		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			operationId: OPERATION_ID,
			outcome: 'rejected',
			error: {
				code: 'CAR_VALIDATION_FAILED',
				message: 'Car change needs attention',
				details: {
					formErrors: [],
					fieldErrors: {
						base: [
							'Base values must be provided for exactly the changed fields',
						],
					},
				},
			},
		});
		d1.expectConsumed();
	});

	test('durably rejects an unsupported wire-contract version without changing a Car', async () => {
		const { d1, request } = createHonoFixture();
		d1.queue(
			{
				kind: 'first',
				value: {
					ownerId: 'owner-1',
					operationId: OPERATION_ID,
					contractVersion: 2,
					kind: 'car.create',
					entityType: 'car',
					entityId: CAR_ID,
					requestHash: UNSUPPORTED_REQUEST_HASH,
					outcome: 'pending',
					httpStatus: null,
					responseJson: null,
					createdAt: '2026-08-11T00:00:00.000Z',
					completedAt: null,
				},
			},
			{ kind: 'run' },
		);

		const response = await request(
			`/api/v1/sync/operations/${OPERATION_ID}`,
			jsonRequest({ ...createCommand, contractVersion: 2 }),
		);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			operationId: OPERATION_ID,
			outcome: 'rejected',
			error: {
				code: 'OPERATION_CONTRACT_UNSUPPORTED',
				message: 'Operation contract version is not supported',
				details: { supported: [1], received: 2 },
			},
		});
		expect(d1.batches).toEqual([]);
		d1.expectConsumed();
	});

	test('leaves a claimed operation pending when D1 is temporarily unavailable', async () => {
		const { d1, request } = createHonoFixture();
		d1.queue(
			{
				kind: 'first',
				value: {
					ownerId: 'owner-1',
					operationId: OPERATION_ID,
					contractVersion: 1,
					kind: 'car.edit',
					entityType: 'car',
					entityId: CAR_ID,
					requestHash: EDIT_REQUEST_HASH,
					outcome: 'pending',
					httpStatus: null,
					responseJson: null,
					createdAt: '2026-08-11T00:00:00.000Z',
					completedAt: null,
				},
			},
			{ kind: 'error', error: new Error('D1 unavailable') },
		);

		const response = await request(
			`/api/v1/sync/operations/${OPERATION_ID}`,
			jsonRequest({
				contractVersion: 1,
				command: {
					type: 'car.edit',
					carId: CAR_ID,
					baseVersion: 1,
					base: { name: 'B7 carpet' },
					changes: { name: 'B7 carpet club setup' },
				},
			}),
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: {
				code: 'SYNC_TEMPORARILY_UNAVAILABLE',
				message: 'Car synchronization is temporarily unavailable',
			},
		});
		expect(d1.batches).toEqual([]);
		d1.expectConsumed();
	});

	test('does not report remote success when a concurrent Car write wins the compare-and-swap', async () => {
		const { d1, request } = createHonoFixture();
		d1.queue(
			{ kind: 'first', value: pendingReceipt('car.edit', EDIT_REQUEST_HASH) },
			{ kind: 'first', value: carRow() },
			{ kind: 'batch' },
			{ kind: 'first', value: null },
		);

		const response = await request(
			`/api/v1/sync/operations/${OPERATION_ID}`,
			jsonRequest({
				contractVersion: 1,
				command: {
					type: 'car.edit',
					carId: CAR_ID,
					baseVersion: 1,
					base: { name: 'B7 carpet' },
					changes: { name: 'B7 carpet club setup' },
				},
			}),
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: { code: 'SYNC_TEMPORARILY_UNAVAILABLE' },
		});
		d1.expectConsumed();
	});

	test.each([
		[
			'invalid changed Car fields',
			{
				contractVersion: 1,
				command: {
					type: 'car.edit',
					carId: CAR_ID,
					baseVersion: 1,
					base: { name: 'B7 carpet' },
					changes: { name: '' },
				},
			},
			'car.edit',
			INVALID_EDIT_CHANGES_REQUEST_HASH,
		],
		[
			'invalid edit concurrency metadata',
			{
				contractVersion: 1,
				command: {
					type: 'car.edit',
					carId: CAR_ID,
					baseVersion: -1,
					base: { name: 'B7 carpet' },
					changes: { name: 'New' },
				},
			},
			'car.edit',
			INVALID_EDIT_STRUCTURE_REQUEST_HASH,
		],
		[
			'invalid lifecycle base',
			{
				contractVersion: 1,
				command: {
					type: 'car.restore',
					carId: CAR_ID,
					baseVersion: 2,
					base: { archivedAt: null },
				},
			},
			'car.restore',
			INVALID_LIFECYCLE_REQUEST_HASH,
		],
		[
			'non-string Car field',
			{
				contractVersion: 1,
				command: {
					type: 'car.create',
					carId: CAR_ID,
					car: { name: [1] },
				},
			},
			'car.create',
			INVALID_ARRAY_REQUEST_HASH,
		],
	] as const)(
		'retains %s as canonical Needs-attention work',
		async (_label, body, kind, requestHash) => {
			const { d1, request } = createHonoFixture();
			d1.queue(
				{ kind: 'first', value: pendingReceipt(kind, requestHash) },
				{ kind: 'run' },
			);

			const response = await request(
				`/api/v1/sync/operations/${OPERATION_ID}`,
				jsonRequest(body),
			);

			expect(response.status).toBe(422);
			expect(await response.json()).toMatchObject({
				operationId: OPERATION_ID,
				outcome: 'rejected',
				error: { code: 'CAR_VALIDATION_FAILED' },
			});
			d1.expectConsumed();
		},
	);

	test('restores across a descriptive edit and resumes only Car-paused maintenance', async () => {
		const archivedAt = '2026-08-10T12:00:00.000Z';
		const restoredResponse = {
			operationId: OPERATION_ID,
			outcome: 'applied',
			car: {
				id: CAR_ID,
				name: 'Remote descriptive edit',
				make: 'Team Associated',
				model: 'B7',
				scale: '1/10',
				vehicleType: 'buggy',
				powerType: 'electric',
				notes: null,
				currentSetupId: null,
				createdAt: '2026-08-10T00:00:00.000Z',
				archivedAt: null,
				version: 3,
			},
		};
		const { d1, request } = createHonoFixture();
		d1.queue(
			{
				kind: 'first',
				value: pendingReceipt('car.restore', RESTORE_REQUEST_HASH),
			},
			{
				kind: 'first',
				value: carRow({ name: 'Remote descriptive edit', archivedAt }),
			},
			{ kind: 'batch' },
			{
				kind: 'first',
				value: appliedReceipt(
					'car.restore',
					RESTORE_REQUEST_HASH,
					restoredResponse,
				),
			},
		);

		const response = await request(
			`/api/v1/sync/operations/${OPERATION_ID}`,
			jsonRequest({
				contractVersion: 1,
				command: {
					type: 'car.restore',
					carId: CAR_ID,
					baseVersion: 2,
					base: { archivedAt },
				},
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(restoredResponse);
		expect(d1.batches[0]?.[1]).toContain('"pause_reason" = ?');
		d1.expectConsumed();
	});

	test('durably rejects a missing lifecycle target through the owner-safe contract', async () => {
		const { d1, request } = createHonoFixture();
		d1.queue(
			{
				kind: 'first',
				value: pendingReceipt('car.archive', ARCHIVE_REQUEST_HASH),
			},
			{ kind: 'first', value: null },
			{ kind: 'run' },
		);

		const response = await request(
			`/api/v1/sync/operations/${OPERATION_ID}`,
			jsonRequest({
				contractVersion: 1,
				command: {
					type: 'car.archive',
					carId: CAR_ID,
					baseVersion: 1,
					base: { archivedAt: null },
				},
			}),
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({
			operationId: OPERATION_ID,
			outcome: 'rejected',
			error: { code: 'CAR_NOT_FOUND' },
		});
		d1.expectConsumed();
	});

	test('scopes an operation identity to the authenticated User', async () => {
		const createdResponse = {
			operationId: OPERATION_ID,
			outcome: 'applied',
			car: {
				id: CAR_ID,
				name: 'B7 carpet',
				make: null,
				model: null,
				scale: null,
				vehicleType: null,
				powerType: null,
				notes: null,
				currentSetupId: null,
				createdAt: '2026-08-11T00:00:00.000Z',
				archivedAt: null,
				version: 1,
			},
		};
		const { d1, request } = createHonoFixture({ userId: 'owner-2' });
		d1.queue(
			{
				kind: 'first',
				value: pendingReceipt('car.create', REQUIRED_CREATE_REQUEST_HASH, {
					ownerId: 'owner-2',
				}),
			},
			{ kind: 'batch' },
			{
				kind: 'first',
				value: {
					...appliedReceipt(
						'car.create',
						REQUIRED_CREATE_REQUEST_HASH,
						createdResponse,
					),
					ownerId: 'owner-2',
				},
			},
		);

		const response = await request(
			`/api/v1/sync/operations/${OPERATION_ID}`,
			jsonRequest({
				contractVersion: 1,
				command: {
					type: 'car.create',
					carId: CAR_ID,
					car: { name: 'B7 carpet' },
				},
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(createdResponse);
		expect(d1.queries[0]?.values).toContain('owner-2');
		d1.expectConsumed();
	});

	test.each([
		[
			'invalid operation ID',
			'/api/v1/sync/operations/not-a-uuid',
			jsonRequest(createCommand),
		],
		[
			'invalid JSON',
			`/api/v1/sync/operations/${OPERATION_ID}`,
			{
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: '{',
			},
		],
		[
			'invalid envelope',
			`/api/v1/sync/operations/${OPERATION_ID}`,
			jsonRequest({}),
		],
	] as const)(
		'returns an unreceipted 400 for %s',
		async (_label, path, init) => {
			const { d1, request } = createHonoFixture();

			const response = await request(path, init);

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				error: { code: 'INVALID_OPERATION' },
			});
			d1.expectConsumed();
		},
	);

	test('requires authentication before touching an operation receipt', async () => {
		const { d1, request } = createHonoFixture(false);

		const response = await request(
			`/api/v1/sync/operations/${OPERATION_ID}`,
			jsonRequest(createCommand),
		);

		expect(response.status).toBe(401);
		d1.expectConsumed();
	});

	test('reports a receipt-claim race without applying an unclaimed operation', async () => {
		const { d1, request } = createHonoFixture();
		d1.queue({ kind: 'first', value: null }, { kind: 'first', value: null });

		const response = await request(
			`/api/v1/sync/operations/${OPERATION_ID}`,
			jsonRequest(createCommand),
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: { code: 'OPERATION_IN_PROGRESS' },
		});
		expect(d1.batches).toEqual([]);
		d1.expectConsumed();
	});

	test.each([
		['missing status', { httpStatus: null }],
		['missing body', { responseJson: null }],
	] as const)(
		'fails closed for a terminal receipt with a %s',
		async (_label, override) => {
			const { d1, request } = createHonoFixture();
			d1.queue(
				{ kind: 'first', value: null },
				{
					kind: 'first',
					value: {
						...appliedReceipt('car.create', CREATE_REQUEST_HASH, {}),
						...override,
					},
				},
			);

			const response = await request(
				`/api/v1/sync/operations/${OPERATION_ID}`,
				jsonRequest(createCommand),
			);

			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				error: { code: 'SYNC_TEMPORARILY_UNAVAILABLE' },
			});
			d1.expectConsumed();
		},
	);

	test('normalizes a non-Error infrastructure rejection without finalizing the receipt', async () => {
		const { d1, request } = createHonoFixture();
		d1.queue(
			{ kind: 'first', value: pendingReceipt('car.edit', EDIT_REQUEST_HASH) },
			{ kind: 'error', error: 'D1 unavailable' },
		);

		const response = await request(
			`/api/v1/sync/operations/${OPERATION_ID}`,
			jsonRequest({
				contractVersion: 1,
				command: {
					type: 'car.edit',
					carId: CAR_ID,
					baseVersion: 1,
					base: { name: 'B7 carpet' },
					changes: { name: 'B7 carpet club setup' },
				},
			}),
		);

		expect(response.status).toBe(503);
		d1.expectConsumed();
	});
});
