import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { openApi } from './openapi';
import {
	carEditSyncCommandInput,
	carLifecycleSyncCommandInput,
	carSyncEnvelopeInput,
} from './types';

const request =
	openApi.paths['/api/v1/sync/operations/{operationId}'].put.requestBody
		.content['application/json'].schema;
const carId = '20000000-0000-4000-8000-000000000001';

describe('Car sync OpenAPI strict object parity', () => {
	test('documents the strict envelope without tightening its extensible command dispatcher', () => {
		expect(request.additionalProperties).toBe(false);
		expect(
			carSyncEnvelopeInput.safeParse({
				contractVersion: 1,
				command: { type: 'car.create', carId, car: { name: 'Buggy' } },
				unexpected: true,
			}).success,
		).toBe(false);
	});

	test.each([
		{
			type: 'car.edit',
			schema: carEditSyncCommandInput,
			command: {
				type: 'car.edit',
				carId,
				baseVersion: 1,
				base: { name: 'Buggy' },
				changes: { name: 'Updated' },
			},
		},
		{
			type: 'car.archive',
			schema: carLifecycleSyncCommandInput.options[0],
			command: {
				type: 'car.archive',
				carId,
				baseVersion: 1,
				base: { archivedAt: null },
			},
		},
		{
			type: 'car.restore',
			schema: carLifecycleSyncCommandInput.options[1],
			command: {
				type: 'car.restore',
				carId,
				baseVersion: 1,
				base: { archivedAt: '2026-10-09T00:00:00.000Z' },
			},
		},
	])(
		'rejects undeclared fields for $type and its base witness',
		({ type, schema, command }) => {
			const documented = request.properties.command.oneOf.find(
				(entry) =>
					typeof entry.properties.type === 'object' &&
					entry.properties.type.const === type,
			);
			const runtime = z.toJSONSchema(schema, { io: 'input' });
			expect(documented).toBeDefined();
			expect(documented).toMatchObject({
				additionalProperties: runtime.additionalProperties,
				properties: { base: { additionalProperties: false } },
			});
			expect(runtime.additionalProperties).toBe(false);
			expect(schema.safeParse(command).success).toBe(true);
			expect(schema.safeParse({ ...command, unexpected: true }).success).toBe(
				false,
			);
			expect(
				schema.safeParse({
					...command,
					base: { ...command.base, unexpected: true },
				}).success,
			).toBe(false);
		},
	);

	test('preserves stripping semantics for edit changes', () => {
		const command = {
			type: 'car.edit',
			carId,
			baseVersion: 1,
			base: { name: 'Buggy' },
			changes: { name: 'Updated', unexpected: true },
		};
		expect(carEditSyncCommandInput.parse(command).changes).toEqual({
			name: 'Updated',
		});
		const documented = request.properties.command.oneOf.find(
			(entry) =>
				typeof entry.properties.type === 'object' &&
				entry.properties.type.const === 'car.edit',
		);
		expect(documented).not.toMatchObject({
			properties: { changes: { additionalProperties: false } },
		});
	});
});
