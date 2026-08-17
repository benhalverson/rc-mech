import assert from 'node:assert/strict';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
	configuredOrigin,
	configuredOrigins,
	hasEmailDelivery,
	hasMagicLinkConfiguration,
	isAllowedOrigin,
} from './auth-policy';
import { componentSlotType } from './component-policy';
import {
	calculateConsumableReport,
	mapSetupTiresToAxles,
} from './consumable-policy';
import { createEmailSender } from './email';
import {
	addCalendarInterval,
	canTransitionMaintenance,
} from './maintenance-policy';
import { validatePhotoMetadata } from './photo-policy';
import { required } from './routes/invariant';
import { jsonText, jsonValue } from './routes/json-values';
import {
	consumableInsertValues,
	publicConsumable,
} from './routes/maintenance/consumable-records';
import { planDue } from './routes/maintenance/plan-records';
import { draftValues, publicImportDraft } from './routes/setups/import-records';
import {
	fetchSoDialedSource,
	readLimitedText,
} from './routes/setups/import-source';
import {
	publicSetup,
	setupCopyValue,
	setupInsertValues,
} from './routes/setups/setup-records';
import * as schema from './schema';
import {
	defaultImportExtractor,
	isSupportedPdfReference,
	resolveSetupImport,
} from './setup-import-policy';
import { chooseCopySource, shouldSelectCurrentSetup } from './setup-policy';
import {
	consumableInput,
	consumableUpdateInput,
	maintenancePlanInput,
	setupImportSourceUrl,
} from './types';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('backend defensive and alternate paths', () => {
	test('fails closed for missing and malformed deployment origins', () => {
		assert.equal(configuredOrigin(), undefined);
		assert.equal(configuredOrigin('not a URL'), undefined);
		assert.deepEqual(configuredOrigins(undefined), []);
		assert.deepEqual(configuredOrigins('https://garage.example'), [
			'https://garage.example',
		]);
		assert.deepEqual(configuredOrigins('https://garage.example', true), [
			'https://garage.example',
		]);
		assert.equal(isAllowedOrigin(undefined), false);
		assert.equal(isAllowedOrigin('https://garage.example'), false);
		assert.equal(hasMagicLinkConfiguration({ APP_URL: 'bad' }), false);
		assert.equal(
			hasEmailDelivery({ EMAIL: {}, EMAIL_FROM: 'from@example.com' }),
			true,
		);
	});

	test('uses the no-op sender when production has no email binding', async () => {
		const sender = createEmailSender({ ENVIRONMENT: 'production' } as Env);
		assert.equal(sender.available, false);
		await sender.send({
			from: 'a@example.com',
			to: 'b@example.com',
			subject: 's',
			text: 't',
		});
	});

	test('covers policy edge cases and alternate data shapes', () => {
		assert.equal(componentSlotType('bespoke', 'standard'), 'invalid');
		assert.deepEqual(mapSetupTiresToAxles(null), { front: null, rear: null });
		assert.deepEqual(mapSetupTiresToAxles({ frontTires: { compound: 'A' } }), {
			front: { compound: 'A' },
			rear: { frontTires: { compound: 'A' } },
		});
		assert.equal(
			validatePhotoMetadata({
				contentType: 'image/png',
				fileName: 'x.png',
				byteSize: 1.5,
			}),
			'Photo must not be empty',
		);
		assert.equal(
			addCalendarInterval('2026-01-01T00:00:00.000Z', 'none', 1, 'UTC'),
			'2026-01-01T00:00:00.000Z',
		);
		for (const [from, to, expected] of [
			['active', 'active', false],
			['paused', 'paused', false],
			['archived', 'active', false],
			['active', 'archived', true],
			['paused', 'archived', true],
		] as const)
			assert.equal(canTransitionMaintenance(from, to), expected);
	});

	test('reports mixed currency, incomplete, legacy, and malformed consumable data', () => {
		const report = calculateConsumableReport([
			{
				id: 'front-1',
				kind: 'tires',
				performedAt: '2026-03-03T00:00:00.000Z',
				frontDetails: 'not-json',
				frontCost: 10,
				frontCurrency: 'USD',
			},
			{
				id: 'front-2',
				kind: 'tires',
				performedAt: '2026-03-01T00:00:00.000Z',
				front: { details: 'A', cost: 8, currency: 'EUR' },
			},
			{
				id: 'rear-1',
				kind: 'tires',
				performedAt: '2026-03-02T00:00:00.000Z',
				rear: { details: 'B' },
			},
			{ kind: 'fluid', performedAt: '2026-03-01T00:00:00.000Z' },
			{
				kind: 'tires',
				performedAt: '2026-02-01T00:00:00.000Z',
				front: '',
				archivedAt: '2026-03-01T00:00:00.000Z',
			},
		]);
		assert.equal(report.tires.frequency.front.status, 'calculated');
		assert.equal(report.tires.spend.combined.total, null);
		assert.equal(report.tires.spend.rear.isIncomplete, true);
		assert.equal(report.fluidHistory[0].area, 'custom');
	});

	test('covers setup import validation and empty extraction metadata', async () => {
		assert.equal(isSupportedPdfReference('bad'), false);
		assert.equal(isSupportedPdfReference('http://example.com/file.pdf'), false);
		const extracted = await defaultImportExtractor({
			canonicalUrl: 'https://www.sodialed.com/setup/a',
			html: '<html></html>',
		});
		assert.deepEqual(extracted.sourceIdentity, {});
		await assert.rejects(
			resolveSetupImport(
				'https://example.com/setup/a',
				async () => ({ canonicalUrl: '', html: '' }),
				defaultImportExtractor,
			),
			/Unsupported/,
		);
	});

	test('covers setup selection fallbacks', () => {
		const older = { id: 'a', updatedAt: '2026-01-01', createdAt: '2026-01-01' };
		const newerCreated = {
			id: 'b',
			updatedAt: '2026-01-01',
			createdAt: '2026-01-02',
		};
		const newerUpdated = {
			id: 'c',
			updatedAt: '2026-01-02',
			createdAt: '2025-01-01',
		};
		assert.equal(
			chooseCopySource([older, newerCreated, newerUpdated])?.id,
			'c',
		);
		assert.equal(chooseCopySource([older], 'a')?.id, 'a');
		assert.equal(chooseCopySource([newerUpdated, older])?.id, 'c');
		assert.equal(shouldSelectCurrentSetup(), false);
	});

	test('covers shared JSON, required-value, and bounded response helpers', async () => {
		assert.equal(jsonText(undefined), undefined);
		assert.equal(jsonText(null), null);
		assert.equal(jsonValue(null), null);
		assert.equal(jsonValue('not-json'), 'not-json');
		assert.throws(() => required(null, 'missing'), /missing/);
		assert.equal(await readLimitedText(new Response(null)), '');
		await assert.rejects(
			readLimitedText(new Response('too large'), 2),
			/too large/,
		);
	});

	test('maps absent and rich setup persistence values without losing shape', () => {
		const now = '2026-01-01T00:00:00.000Z';
		const emptySetup = {
			id: 'setup-1',
			carId: 'car-1',
			name: 'Baseline',
			status: 'active',
			setupDate: null,
			track: null,
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
			version: 1,
			lastOperationId: null,
		} satisfies typeof schema.setup.$inferSelect;
		const richSetup = {
			...emptySetup,
			setupDate: now,
			track: 'Track',
			event: 'Club race',
			surface: 'Dirt',
			traction: 'High',
			moisture: 'Dry',
			condition: 'Smooth',
			temperature: '70 F',
			vehicle: '{"weight":1500}',
			drivetrain: '{"diff":"gear"}',
			electronics: '{"esc":"stock"}',
			tires: '{"front":"A"}',
			shocks: '{"oil":35}',
			frontSuspension: '{"toe":1}',
			rearSuspension: '{"toe":2}',
			notes: 'Fast',
			sourceUrl: 'https://www.sodialed.com/setup/abc',
			sourcePdfReference: 'setup.pdf',
			sourceMetadata: '{"pdfUrl":"https://example.com/setup.pdf","pdfPage":2}',
			rawValues: '{"raw":true}',
			unmappedValues: '{"other":true}',
		} satisfies typeof schema.setup.$inferSelect;

		assert.deepEqual(publicSetup(emptySetup).sections.vehicle, {});
		assert.deepEqual(publicSetup(emptySetup).sections.notes, {});
		assert.equal(publicSetup(richSetup).source.pdfPage, 2);
		assert.deepEqual(publicSetup(richSetup).sections.notes, {
			setupNotes: 'Fast',
		});
		assert.equal(
			setupInsertValues('id', 'car', { name: 'Empty' }, now).status,
			'active',
		);
		assert.equal(
			setupInsertValues(
				'id',
				'car',
				{
					name: 'Rich',
					status: 'reviewed',
					setupDate: now,
					track: 'Track',
					event: 'Race',
					surface: 'Dirt',
					traction: 'High',
					moisture: 'Dry',
					condition: 'Smooth',
					temperature: '70 F',
					vehicle: { weight: 1500 },
					drivetrain: { diff: 'gear' },
					electronics: { esc: 'stock' },
					tires: { front: 'A' },
					shocks: { oil: 35 },
					frontSuspension: { toe: 1 },
					rearSuspension: { toe: 2 },
					notes: 'Fast',
					sourceUrl: 'https://example.com',
					sourcePdfReference: 'setup.pdf',
					sourceMetadata: { pdfPage: 2 },
					rawValues: { raw: true },
					unmappedValues: { other: true },
				},
				now,
			).track,
			'Track',
		);
		assert.equal(setupCopyValue(emptySetup).track, undefined);
		assert.equal(setupCopyValue(richSetup).track, 'Track');
	});

	test('maps import drafts, maintenance plans, and consumable variants', () => {
		const now = '2026-01-01T00:00:00.000Z';
		const emptyDraft = {
			id: 'draft-1',
			ownerId: 'owner-1',
			carId: null,
			sourceUrl: 'https://www.sodialed.com/setup/abc',
			sourceKey: 'https://www.sodialed.com/setup/abc',
			status: 'draft',
			sourceIdentity: null,
			sourcePdfReference: null,
			sourceMetadata: null,
			knownValues: null,
			uncertainValues: null,
			rawValues: null,
			unmappedValues: null,
			error: null,
			acceptedSetupId: null,
			createdAt: now,
			updatedAt: now,
		} satisfies typeof schema.setupImportDraft.$inferSelect;
		assert.deepEqual(publicImportDraft(emptyDraft).knownValues, {});
		expect(
			draftValues({
				knownValues: {},
				uncertainValues: {},
				rawValues: {},
				unmappedValues: {},
			}),
		).toEqual(
			expect.objectContaining({ sourceIdentity: null, sourceMetadata: null }),
		);

		const basePlan = {
			id: 'plan-1',
			carId: 'car-1',
			componentId: null,
			name: 'Plan',
			intervalDays: null,
			intervalSessions: null,
			intervalUnit: '',
			intervalValue: 0,
			baselineAt: now,
			baselineSessionCount: 0,
			status: 'active',
			pauseReason: null,
			pausedAt: null,
		} satisfies typeof schema.maintenancePlan.$inferSelect;
		assert.equal(planDue(basePlan, 0, 'UTC', now).intervalValue, null);
		assert.equal(
			planDue({ ...basePlan, intervalDays: 2 }, 0, 'UTC', now).intervalValue,
			2,
		);

		const baseConsumable = {
			id: 'entry-1',
			carId: 'car-1',
			kind: 'tires',
			performedAt: now,
			fluidArea: null,
			customFluidArea: null,
			frontDetails: null,
			frontCost: null,
			frontCurrency: null,
			rearDetails: '{"details":"Rear"}',
			rearCost: null,
			rearCurrency: null,
			cost: null,
			currency: null,
			notes: null,
			prefilledFromSetupId: null,
			archivedAt: null,
			createdAt: now,
			updatedAt: now,
		} satisfies typeof schema.consumableMaintenanceEntry.$inferSelect;
		assert.equal(publicConsumable(baseConsumable).axle, 'rear');
		assert.equal(
			publicConsumable({
				...baseConsumable,
				frontDetails: '{"details":"Front"}',
			}).axle,
			'both',
		);
		assert.equal(
			publicConsumable({
				...baseConsumable,
				kind: 'fluid',
				fluidArea: 'custom',
				customFluidArea: 'Shock package',
				rearDetails: null,
			}).kind,
			'shock-fluid',
		);
		assert.equal(
			publicConsumable({
				...baseConsumable,
				kind: 'fluid',
				fluidArea: 'rear-shocks',
				rearDetails: null,
			}).kind,
			'shock-fluid',
		);
		assert.equal(
			consumableInsertValues(
				'id',
				'car',
				{
					kind: 'tires',
					performedAt: now,
					front: { details: 'Front', cost: 5, currency: 'USD' },
					rear: { details: 'Rear', cost: 6, currency: 'USD' },
				},
				now,
				null,
			).rearCost,
			6,
		);
		assert.equal(
			consumableInsertValues(
				'id',
				'car',
				{
					kind: 'fluid',
					performedAt: now,
					fluidArea: 'front-shocks',
				},
				now,
				null,
			).cost,
			null,
		);
	});

	test('rejects unusable So Dialed responses without following redirects', async () => {
		for (const response of [
			new Response('', { status: 503 }),
			new Response('', {
				status: 200,
				headers: { location: 'https://example.com' },
			}),
		]) {
			vi.stubGlobal(
				'fetch',
				vi.fn(async () => response),
			);
			await assert.rejects(
				fetchSoDialedSource(new URL('https://www.sodialed.com/setup/a')),
				/unavailable/,
			);
		}
		const redirected = new Response('ok');
		Object.defineProperty(redirected, 'url', { value: 'https://example.com/' });
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => redirected),
		);
		await assert.rejects(
			fetchSoDialedSource(new URL('https://www.sodialed.com/setup/a')),
			/redirected/,
		);
	});

	test('aborts a stalled So Dialed request at the bounded timeout', async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async (_input: RequestInfo | URL, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener('abort', () =>
							reject(new DOMException('aborted', 'AbortError')),
						);
					}),
			),
		);
		const pending = fetchSoDialedSource(
			new URL('https://www.sodialed.com/setup/a'),
		);
		const rejection = expect(pending).rejects.toThrow('aborted');
		await vi.advanceTimersByTimeAsync(8_000);
		await rejection;
	});

	test('executes every declarative schema foreign-key reference', () => {
		let references = 0;
		for (const value of Object.values(schema)) {
			const config = getTableConfig(value);
			for (const foreignKey of config.foreignKeys) {
				foreignKey.reference();
				references += 1;
			}
		}
		expect(references).toBe(43);
	});

	test('covers consumable cross-field validation alternatives', () => {
		for (const value of [
			{
				kind: 'fluid',
				performedAt: '2026-01-01T00:00:00.000Z',
				fluidArea: 'front-shocks',
				customFluidArea: 'wrong',
			},
			{
				kind: 'fluid',
				performedAt: '2026-01-01T00:00:00.000Z',
				fluidArea: 'front-shocks',
				cost: 1,
			},
			{
				kind: 'fluid',
				performedAt: '2026-01-01T00:00:00.000Z',
				fluidArea: 'custom',
			},
		])
			assert.equal(consumableInput.safeParse(value).success, false);
		assert.equal(
			consumableUpdateInput.safeParse({ cost: null, currency: 'USD' }).success,
			false,
		);
		assert.equal(
			consumableUpdateInput.safeParse({ cost: null, currency: null }).success,
			true,
		);
		assert.equal(
			maintenancePlanInput.safeParse({
				carId: 'car-1',
				name: 'Sessions only',
				intervalSessions: 5,
			}).success,
			true,
		);
		assert.equal(
			setupImportSourceUrl.safeParse('https://www.sodialed.com:443/setup/abc')
				.success,
			true,
		);
	});
});
