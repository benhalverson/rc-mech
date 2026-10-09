import { describe, expect, it } from 'vitest';
import { applyMaintenanceChange } from '../../../../../shared/maintenance-sync';
import {
	maintenanceOperationFixture,
	maintenanceSnapshotFixture,
} from '../maintenance-sync.testing';
import {
	buildMaintenanceOperation,
	maintenanceView,
	rebaseMaintenanceOperation,
} from '../maintenance-sync-rules';
import { buildTireReport } from './consumable.rules';
import type { ConsumableCommand } from './consumable-store';
import { tireRecord } from './consumable-sync.testing';
import { consumableChange, consumableEntry } from './consumable-sync-rules';

const now = '2026-10-09T12:00:00.000Z';

const create: ConsumableCommand = {
	kind: 'save',
	mode: 'create',
	carId: 'car',
	id: null,
	maintenance: {
		kind: 'tires',
		axle: 'both',
		frontDetails: 'Front pins',
		rearDetails: 'Rear pins',
		frontCost: 10,
		rearCost: 20,
		performedAt: now,
	},
};
const context = {
	ownerKey: 'owner',
	operationId: 'op',
	entityId: 'tire',
	createdAt: now,
	sessionCounts: new Map<string, number>(),
	dependencies: [
		{ carId: 'car', operationId: 'car-create' },
		{ carId: 'other', operationId: 'independent' },
	],
};
describe('Consumable working-copy rules', () => {
	it('counts one stable entry across restart, replay, acknowledgement and dependent edits', () => {
		const snapshot = { ...maintenanceSnapshotFixture, collections: [] };
		const operation = buildMaintenanceOperation(
			create,
			maintenanceView(snapshot, []),
			context,
		);
		const pending = maintenanceView(snapshot, [operation, operation]);
		expect(pending.current.collections[0].consumables).toHaveLength(1);
		expect(
			buildTireReport(
				pending.current.collections[0].consumables?.map(consumableEntry) ?? [],
			).spend.combined,
		).toBe(30);
		const collection = pending.current.collections[0];
		const edit = buildMaintenanceOperation(
			{ ...create, id: 'tire', mode: 'edit' },
			pending,
			{ ...context, operationId: 'edit' },
		);
		expect(edit.dependencies).toEqual(['car-create', 'op']);
		const rebased = rebaseMaintenanceOperation(edit, 'op', {
			...collection,
			version: 2,
		});
		expect(rebased.command).toMatchObject({
			baseVersion: 2,
			base: { id: 'tire' },
		});
		expect(rebased.dependencies).toEqual(['car-create']);
		expect(rebaseMaintenanceOperation(edit, 'absent', collection)).toBe(edit);
		expect(
			rebaseMaintenanceOperation({ ...edit, dependencies: ['op'] }, 'op', {
				...collection,
				consumables: [],
			}).command,
		).toMatchObject({ base: { id: 'tire' } });
		expect(
			rebaseMaintenanceOperation(
				{ ...operation, dependencies: ['op'] },
				'op',
				collection,
			).command,
		).toMatchObject({ base: null });
		const archived = consumableChange(
			{ kind: 'change', action: 'archive', entry: consumableEntry(tireRecord) },
			[tireRecord],
			'unused',
			2,
		);
		const view = applyMaintenanceChange(collection, archived, now, 0);
		expect(
			buildTireReport(view.consumables?.map(consumableEntry) ?? []).front
				.eventCount,
		).toBe(0);
		const restored = applyMaintenanceChange(
			view,
			{
				...archived,
				action: 'restore',
				base: view.consumables?.[0] ?? tireRecord,
			},
			now,
			0,
		);
		expect(
			buildTireReport(restored.consumables?.map(consumableEntry) ?? []).spend
				.combined,
		).toBe(30);
	});
	it('waits for related Service work while unrelated Cars and records remain independent', () => {
		const service = {
			...maintenanceOperationFixture,
			command: {
				type: 'maintenance.change' as const,
				entity: 'service' as const,
				carId: 'car',
				baseVersion: 1,
				recordId: 'service',
				base: null,
				planBase: null,
				action: 'save' as const,
				baselineSessionCount: 0,
				input: {
					componentId: null,
					performedAt: now,
					description: 'Oil',
					notes: null,
					cost: null,
					currency: null,
				},
			},
		};
		const pending = buildMaintenanceOperation(
			create,
			maintenanceView(maintenanceSnapshotFixture, []),
			context,
		);
		const result = buildMaintenanceOperation(
			{ ...create, id: 'tire' },
			maintenanceView(maintenanceSnapshotFixture, [
				service,
				pending,
				{ ...pending, carId: 'other', operationId: 'other' },
			]),
			context,
		);
		expect(result.dependencies).toContain(service.operationId);
		expect(result.dependencies).not.toContain('other');
		const plan = buildMaintenanceOperation(
			{
				kind: 'save-plan',
				mode: 'create',
				id: null,
				plan: {
					carId: 'car',
					name: 'Clean',
					intervalUnit: 'days',
					intervalValue: 7,
					baselineSessionCount: 0,
				},
			},
			maintenanceView(maintenanceSnapshotFixture, [pending]),
			{ ...context, entityId: 'new-plan' },
		);
		expect(plan.dependencies).not.toContain('op');
	});
	it('preserves accepted axle and fluid inputs without network lookups', () => {
		for (const axle of ['front', 'rear', 'both'] as const) {
			for (const prices of [{ frontCost: 0, rearCost: 20 }, {}]) {
				const command = consumableChange(
					{
						...create,
						maintenance: { kind: 'tires', axle, performedAt: now, ...prices },
					},
					[],
					'new',
					0,
				);
				const collection = applyMaintenanceChange(
					{ carId: 'car', version: 0, plans: [], records: [] },
					command,
					now,
					0,
				);
				expect(
					consumableEntry(collection.consumables?.[0] ?? tireRecord).axle,
				).toBe(axle);
			}
		}
		for (const kind of ['shock-fluid', 'differential-fluid'] as const) {
			for (const additions of [
				{ cost: 5, notes: 'Fresh', customArea: 'rear shock' },
				{},
			]) {
				const command = consumableChange(
					{
						...create,
						maintenance: {
							kind,
							performedAt: now,
							fluidArea:
								kind === 'shock-fluid' ? 'front-shocks' : 'front-differential',
							...additions,
						},
					},
					[],
					'fluid',
					0,
				);
				expect(
					consumableEntry(
						applyMaintenanceChange(
							{ carId: 'car', version: 0, plans: [], records: [] },
							command,
							now,
							0,
						).consumables?.[0] ?? tireRecord,
					).kind,
				).toBe(kind);
			}
		}
		expect(() =>
			consumableChange({ ...create, id: 'missing' }, [], 'new', 0),
		).toThrow('unavailable');
		expect(() =>
			consumableChange(
				{
					kind: 'change',
					action: 'archive',
					entry: { ...consumableEntry(tireRecord), id: '' },
				},
				[],
				'new',
				0,
			),
		).toThrow('unavailable');
	});
	it('reads historical details and keeps mixed-currency totals honest', () => {
		for (const frontDetails of [
			'legacy text',
			'null',
			'{}',
			'{"details":3}',
			'"string"',
		])
			expect(
				consumableEntry({ ...tireRecord, frontDetails }).frontDetails,
			).toBe(frontDetails);
		for (const customFluidArea of ['Shock service', 'Center gear', null])
			expect(
				consumableEntry({
					...tireRecord,
					kind: 'fluid',
					fluidArea: 'custom',
					customFluidArea,
				}).kind,
			).toBe(
				customFluidArea?.startsWith('Shock')
					? 'shock-fluid'
					: 'differential-fluid',
			);
		expect(
			consumableEntry({ ...tireRecord, kind: 'fluid', fluidArea: null }).kind,
		).toBe('differential-fluid');
		const usd = consumableEntry(tireRecord);
		const eur = consumableEntry({
			...tireRecord,
			id: 'eur',
			frontCurrency: 'EUR',
			rearCurrency: 'EUR',
		});
		expect(buildTireReport([usd, eur]).spend).toMatchObject({
			front: null,
			rear: null,
			combined: null,
		});
	});
});
