import { describe, expect, test } from 'vitest';
import { createHonoFixture, type D1Step } from './testing/hono-fixture';

const operationId = '30000000-0000-4000-8000-000000000001';
const timezone = { type: 'timezone', base: 'UTC', timezone: 'Europe/London' };
const envelope = (command: object) => ({ contractVersion: 1, command });
const endpoint = `/api/v1/settings/sync/operations/${operationId}`;
const json = (body: unknown) => ({
	method: 'PUT',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body),
});
const setup = () => {
	const fixture = createHonoFixture();
	const receipt = {
		ownerId: 'owner-1',
		operationId,
		contractVersion: 1,
		kind: 'settings.change',
		entityType: 'settings',
		entityId: 'owner-1',
		get requestHash() {
			return fixture.d1.queries[0]?.values[6];
		},
		outcome: 'pending',
		createdAt: '2026-01-01T00:00:00Z',
	};
	const terminal = (outcome = 'applied', which = 0) => ({
		...receipt,
		outcome,
		httpStatus: outcome === 'applied' ? 200 : 409,
		get responseJson() {
			return [...fixture.d1.batchQueries.flat(), ...fixture.d1.queries]
				.flatMap((query) => query.values)
				.filter(
					(value): value is string =>
						typeof value === 'string' && value.startsWith('{"operationId"'),
				)
				.at(which);
		},
	});
	return { ...fixture, receipt, terminal };
};
const run = async (
	command: object,
	steps: readonly D1Step[],
	outcome = 'applied',
	which = 0,
) => {
	const fixture = setup();
	fixture.d1.queue({ kind: 'first', value: fixture.receipt }, ...steps, {
		kind: 'first',
		value: fixture.terminal(outcome, which),
	});
	const response = await fixture.request(endpoint, json(envelope(command)));
	const result = await response.json();
	fixture.d1.expectConsumed();
	return { fixture, response, result };
};
describe('Settings synchronization', () => {
	test('rejects malformed requests before persistence and requires authentication', async () => {
		const fixture = createHonoFixture();
		expect(
			(await fixture.request(endpoint, { method: 'PUT', body: '{' })).status,
		).toBe(400);
		expect(
			(
				await fixture.request(
					endpoint,
					json({ ...envelope(timezone), extra: true }),
				)
			).status,
		).toBe(400);
		expect(
			(
				await fixture.request(
					'/api/v1/settings/sync/operations/no',
					json(envelope(timezone)),
				)
			).status,
		).toBe(400);
		const anonymous = createHonoFixture({ authenticated: false });
		expect(
			(await anonymous.request(endpoint, json(envelope(timezone)))).status,
		).toBe(401);
	});
	test('applies timezone and terminal receipt in a single conditional batch', async () => {
		const { fixture, response, result } = await run(timezone, [
			{ kind: 'first', value: { timezone: 'UTC' } },
			{ kind: 'batch' },
		]);
		expect(response.status).toBe(200);
		expect(result).toEqual({
			operationId,
			outcome: 'applied',
			timezone: 'Europe/London',
		});
		expect(fixture.d1.batches[0]?.join(' ')).toContain('exists');
		expect(fixture.d1.batches[0]?.[0]).toContain('"owner"."timezone" = ?');
	});
	test('accepts an already-applied timezone without overwriting another value', async () => {
		expect(
			(
				await run(timezone, [
					{ kind: 'first', value: { timezone: 'Europe/London' } },
					{ kind: 'batch' },
				])
			).response.status,
		).toBe(200);
	});
	test('preserves a conflicting remote timezone', async () => {
		const { result } = await run(
			timezone,
			[{ kind: 'first', value: { timezone: 'Asia/Tokyo' } }, { kind: 'run' }],
			'conflict',
		);
		expect(result).toMatchObject({ outcome: 'conflict', remote: 'Asia/Tokyo' });
	});
	test('rejects invalid timezone values, missing owner, and reserved invites', async () => {
		for (const command of [
			{ ...timezone, timezone: 'bad' },
			{ ...timezone, base: 'bad' },
			{ type: 'invite-create', code: 'SETTINGS' },
		])
			expect(
				(await run(command, [{ kind: 'run' }], 'rejected')).response.status,
			).toBe(409);
		expect(
			(
				await run(
					timezone,
					[{ kind: 'first', value: null }, { kind: 'run' }],
					'rejected',
				)
			).response.status,
		).toBe(409);
	});
	test('claims an invite slot with a stable identity and guards its receipt by ownership', async () => {
		const { fixture, result } = await run(
			{ type: 'invite-create', code: 'track-01' },
			[{ kind: 'batch' }],
		);
		expect(result).toMatchObject({
			outcome: 'applied',
			invite: { id: operationId, code: 'TRACK-01' },
		});
		expect(fixture.d1.batches[0]).toHaveLength(7);
		expect(
			fixture.d1.batchQueries[0]
				?.slice(0, 5)
				.every((query) => query.values.includes(operationId)),
		).toBe(true);
		expect(fixture.d1.batches[0]?.[5]).toContain(
			'"invite_code"."creator_id" = ?',
		);
	});
	test('retains canonical invite rejection without retrying a second identity', async () => {
		expect(
			(
				await run(
					{ type: 'invite-create', code: 'TRACK-01' },
					[{ kind: 'batch' }],
					'rejected',
					1,
				)
			).result,
		).toMatchObject({
			outcome: 'rejected',
			error: expect.stringContaining('allowance'),
		});
	});
	test('revokes only the owner available invite and records an idempotent receipt', async () => {
		const { fixture, result } = await run(
			{ type: 'invite-revoke', inviteId: operationId },
			[{ kind: 'batch' }],
		);
		expect(result).toEqual({
			operationId,
			outcome: 'applied',
			revokedInviteId: operationId,
		});
		expect(fixture.d1.batches[0]?.[0]).toContain('"invite_code"."status" = ?');
		expect(
			(
				await run(
					{ type: 'invite-revoke', inviteId: operationId },
					[{ kind: 'batch' }],
					'rejected',
					1,
				)
			).result,
		).toMatchObject({ outcome: 'rejected' });
	});
	test('replays terminal receipts and refuses operation identity reuse', async () => {
		const f = setup();
		f.d1.queue(
			{ kind: 'first', value: null },
			{
				kind: 'first',
				value: {
					...f.receipt,
					get requestHash() {
						return f.receipt.requestHash;
					},
					outcome: 'applied',
					httpStatus: 200,
					responseJson: '{"replayed":true}',
				},
			},
		);
		expect(
			await (await f.request(endpoint, json(envelope(timezone)))).json(),
		).toEqual({ replayed: true });
		f.d1.expectConsumed();
		const reused = setup();
		reused.d1.queue({
			kind: 'first',
			value: { ...reused.receipt, requestHash: 'other' },
		});
		expect(
			(await reused.request(endpoint, json(envelope(timezone)))).status,
		).toBe(409);
	});
	test('returns retryable unavailability for an absent or incomplete receipt and database failure', async () => {
		for (const steps of [
			[
				{ kind: 'first', value: null },
				{ kind: 'first', value: null },
			],
			[{ kind: 'error', error: new Error('offline') }],
		] as D1Step[][]) {
			const f = setup();
			f.d1.queue(...steps);
			expect((await f.request(endpoint, json(envelope(timezone)))).status).toBe(
				503,
			);
		}
		for (const missing of ['httpStatus', 'responseJson']) {
			const f = setup();
			f.d1.queue({
				kind: 'first',
				value: {
					...f.receipt,
					get requestHash() {
						return f.receipt.requestHash;
					},
					outcome: 'applied',
					httpStatus: 200,
					responseJson: '{}',
					[missing]: null,
				},
			});
			expect((await f.request(endpoint, json(envelope(timezone)))).status).toBe(
				503,
			);
		}
	});
	test('records conflict when the timezone changes between read and compare-and-swap', async () => {
		for (const remote of [{ timezone: 'Asia/Tokyo' }, null]) {
			const f = setup();
			f.d1.queue(
				{ kind: 'first', value: f.receipt },
				{ kind: 'first', value: { timezone: 'UTC' } },
				{ kind: 'batch' },
				{ kind: 'first', value: f.receipt },
				{ kind: 'first', value: remote },
				{ kind: 'run' },
				{ kind: 'first', value: f.terminal('conflict', -1) },
			);
			const response = await f.request(endpoint, json(envelope(timezone)));
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({
				outcome: 'conflict',
				remote: remote?.timezone ?? 'UTC',
			});
			f.d1.expectConsumed();
		}
	});
	test('does not claim success if a committed receipt cannot be read', async () => {
		const f = setup();
		f.d1.queue(
			{ kind: 'first', value: f.receipt },
			{ kind: 'first', value: { timezone: 'UTC' } },
			{ kind: 'batch' },
			{ kind: 'first', value: null },
		);
		expect((await f.request(endpoint, json(envelope(timezone)))).status).toBe(
			503,
		);
		const pending = setup();
		pending.d1.queue(
			{ kind: 'first', value: pending.receipt },
			{ kind: 'batch' },
			{ kind: 'first', value: pending.receipt },
		);
		expect(
			(
				await pending.request(
					endpoint,
					json(envelope({ type: 'invite-revoke', inviteId: operationId })),
				)
			).status,
		).toBe(503);
	});
});
