import { describe, expect, it } from 'vitest';
import type { MaintenanceCommand } from './maintenance-sync.models';
import {
	maintenanceOperationFixture as operation,
	maintenancePlanFixture as plan,
	maintenanceRecordFixture as record,
	maintenanceSnapshotFixture as snapshot,
} from './maintenance-sync.testing';
import {
	buildMaintenanceOperation,
	maintenanceView,
	rebaseMaintenanceOperation,
} from './maintenance-sync-rules';

const context = {
	ownerKey: 'owner',
	operationId: 'op',
	entityId: 'new',
	createdAt: '2026-10-09T12:00:00.000Z',
	sessionCounts: new Map([['car', 2]]),
	dependencies: [
		{ carId: 'car', operationId: 'drive' },
		{ carId: 'other', operationId: 'unrelated' },
	],
};
const planInput = {
	carId: 'car',
	name: 'Bearings',
	intervalUnit: 'days' as const,
	intervalValue: 7,
	baselineSessionCount: 0,
};
const serviceInput = {
	performedAt: record.performedAt,
	description: record.description,
};
describe('Maintenance synchronization rules', () => {
	it('materializes durable intent in sequence without duplicate histories', () => {
		const view = maintenanceView(snapshot, [
			{ ...operation, sequence: 2 },
			{ ...operation, operationId: 'earlier', sequence: 1 },
		]);
		expect(view.current.collections[0].plans).toHaveLength(1);
		expect(view.operations).toHaveLength(2);
		expect(
			maintenanceView({ collections: [], components: [], timezone: 'UTC' }, [
				operation,
			]).current.collections[0].plans,
		).toHaveLength(1);
	});
	it('creates and edits plans with stable identity and related dependencies', () => {
		const view = maintenanceView(snapshot, [
			operation,
			{ ...operation, operationId: 'other', carId: 'other' },
		]);
		const created = buildMaintenanceOperation(
			{ kind: 'save-plan', mode: 'create', id: null, plan: planInput },
			view,
			context,
		);
		expect(created.command).toMatchObject({
			planId: 'new',
			base: null,
			input: { baselineAt: context.createdAt, intervalDays: 7 },
		});
		expect(created.dependencies).toEqual(['drive']);
		const edited = buildMaintenanceOperation(
			{
				kind: 'save-plan',
				mode: 'edit',
				id: 'plan',
				plan: { ...planInput, componentId: 'component' },
			},
			view,
			context,
		);
		expect(edited.command).toMatchObject({
			base: { id: 'plan' },
			input: { componentId: 'component' },
		});
		expect(edited.dependencies).toEqual(['drive', 'operation']);
		const transition = buildMaintenanceOperation(
			{ kind: 'transition-plan', planId: 'plan', action: 'resume' },
			view,
			context,
		);
		expect(transition.command).toMatchObject({ action: 'resume' });
		const empty = maintenanceView(
			{ collections: [], components: [], timezone: 'UTC' },
			[],
		);
		const another = buildMaintenanceOperation(
			{
				kind: 'save-plan',
				mode: 'create',
				id: null,
				plan: {
					...planInput,
					carId: 'other',
					intervalUnit: 'weeks',
					baselineAt: plan.baselineAt,
					intervalSessions: 2,
				},
			},
			empty,
			context,
		);
		expect(another.command).toMatchObject({
			baseVersion: 0,
			input: {
				intervalDays: null,
				baselineAt: plan.baselineAt,
				intervalSessions: 2,
			},
		});
		expect(another.sessionCount).toBe(0);
	});
	it('records, completes, edits, archives, restores, and undoes service with plan dependencies', () => {
		const view = maintenanceView(snapshot, [operation]);
		const commands: MaintenanceCommand[] = [
			{
				kind: 'save-service',
				mode: 'create',
				carId: 'car',
				id: null,
				service: serviceInput,
			},
			{
				kind: 'save-service',
				mode: 'complete',
				carId: 'car',
				id: 'plan',
				service: { ...serviceInput, cost: 5, currency: 'USD', notes: 'Done' },
			},
			{
				kind: 'save-service',
				mode: 'edit',
				carId: 'car',
				id: 'record',
				service: serviceInput,
			},
			{ kind: 'change-service', recordId: 'record', action: 'restore' },
			{ kind: 'undo-activity', recordId: 'record' },
		];
		for (const command of commands) {
			const built = buildMaintenanceOperation(command, view, context);
			expect(built.command.entity).toBe('service');
			expect(built.sessionCount).toBe(2);
		}
		const adHoc = buildMaintenanceOperation(commands[0], view, {
			...context,
			sessionCounts: new Map(),
		});
		expect(adHoc.command).toMatchObject({ baselineSessionCount: 0 });
		expect(adHoc.command).toMatchObject({ recordId: 'new', planBase: null });
		const component = buildMaintenanceOperation(
			{
				kind: 'save-service',
				mode: 'create',
				carId: 'car',
				id: null,
				service: { ...serviceInput, componentId: 'component' },
			},
			view,
			context,
		);
		expect(component.command).toMatchObject({
			input: { componentId: 'component' },
		});
		const prior = buildMaintenanceOperation(commands[1], view, context);
		const next = buildMaintenanceOperation(
			commands[2],
			maintenanceView(snapshot, [prior]),
			context,
		);
		expect(next.dependencies).toContain(prior.operationId);
	});
	it('refuses commands whose saved record disappeared', () => {
		const view = maintenanceView(snapshot, []);
		for (const command of [
			{ kind: 'transition-plan', planId: 'missing', action: 'archive' },
			{ kind: 'change-service', recordId: 'missing', action: 'archive' },
			{
				kind: 'save-service',
				mode: 'edit',
				carId: 'car',
				id: 'missing',
				service: serviceInput,
			},
		] satisfies MaintenanceCommand[])
			expect(() => buildMaintenanceOperation(command, view, context)).toThrow(
				'unavailable',
			);
	});
	it('rebases only related acknowledged versions and preserves missing remote bases', () => {
		const dependent = {
			...operation,
			dependencies: ['ack'],
			command: {
				...operation.command,
				...(operation.command.entity === 'plan' ? { base: plan } : {}),
			},
		};
		const collection = snapshot.collections[0];
		expect(rebaseMaintenanceOperation(operation, 'ack', collection)).toBe(
			operation,
		);
		expect(
			rebaseMaintenanceOperation(dependent, 'ack', {
				...collection,
				version: 2,
			}),
		).toMatchObject({
			dependencies: [],
			command: { baseVersion: 2, base: plan },
		});
		expect(
			rebaseMaintenanceOperation(
				{ ...operation, dependencies: ['ack'] },
				'ack',
				collection,
			).command.base,
		).toBeNull();
		expect(
			rebaseMaintenanceOperation(dependent, 'ack', { ...collection, plans: [] })
				.command.base,
		).toEqual(plan);
		const service = buildMaintenanceOperation(
			{
				kind: 'save-service',
				mode: 'edit',
				carId: 'car',
				id: 'record',
				service: serviceInput,
			},
			maintenanceView(snapshot, []),
			context,
		);
		const related = { ...service, dependencies: ['ack'] };
		expect(
			rebaseMaintenanceOperation(related, 'ack', collection).command,
		).toMatchObject({ base: record, planBase: plan });
		expect(
			rebaseMaintenanceOperation(related, 'ack', {
				...collection,
				plans: [],
				records: [],
			}).command,
		).toMatchObject({ base: record, planBase: plan });
		const created = buildMaintenanceOperation(
			{
				kind: 'save-service',
				mode: 'create',
				carId: 'car',
				id: null,
				service: serviceInput,
			},
			maintenanceView(snapshot, []),
			context,
		);
		expect(
			rebaseMaintenanceOperation(
				{ ...created, dependencies: ['ack'] },
				'ack',
				collection,
			).command,
		).toMatchObject({ base: null, planBase: null });
	});
});
