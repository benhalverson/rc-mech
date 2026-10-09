import {
	applyMaintenanceChange,
	type MaintenanceChange,
	type MaintenanceCollection,
	type PlanRecord,
	type ServiceRecord,
} from '../../../../shared/maintenance-sync';
import type {
	MaintenanceCommand,
	MaintenanceOperation,
	MaintenanceSnapshot,
	MaintenanceView,
} from './maintenance-sync.models';

/**
 * Replays durable Maintenance operations in sequence over canonical collections
 * for route reads. Retained unsuccessful work stays visible; this projection
 * does not claim that its records have been accepted by the server.
 */
export const maintenanceView = (
	canonical: MaintenanceSnapshot,
	operations: readonly MaintenanceOperation[],
): MaintenanceView => {
	const collections = new Map(
		canonical.collections.map((collection) => [collection.carId, collection]),
	);
	for (const operation of [...operations].sort(
		(a, b) => a.sequence - b.sequence,
	)) {
		const collection = collections.get(operation.carId) ?? {
			carId: operation.carId,
			version: 0,
			plans: [],
			records: [],
		};
		collections.set(
			operation.carId,
			applyMaintenanceChange(
				collection,
				operation.command,
				operation.createdAt,
				operation.sessionCount,
			),
		);
	}
	return {
		canonical,
		current: { ...canonical, collections: [...collections.values()] },
		operations,
	};
};
/**
 * Captures a plan/service intent against the materialized Maintenance view,
 * including the service-time usage baseline and necessary record/Car dependencies.
 * Stable IDs and sequence are assigned before storage commits the command.
 */
export const buildMaintenanceOperation = (
	intent: MaintenanceCommand,
	view: MaintenanceView,
	context: Readonly<{
		ownerKey: string;
		operationId: string;
		entityId: string;
		createdAt: string;
		sessionCounts: ReadonlyMap<string, number>;
		dependencies: readonly { carId: string; operationId: string }[];
	}>,
): MaintenanceOperation => {
	const allPlans = view.current.collections.flatMap(
		(collection) => collection.plans,
	);
	const allRecords = view.current.collections.flatMap(
		(collection) => collection.records,
	);
	const planId =
		intent.kind === 'save-plan'
			? intent.id
			: intent.kind === 'transition-plan'
				? intent.planId
				: intent.kind === 'save-service' && intent.mode === 'complete'
					? intent.id
					: null;
	const recordId =
		intent.kind === 'save-service' && intent.mode === 'edit'
			? intent.id
			: intent.kind === 'change-service' || intent.kind === 'undo-activity'
				? intent.recordId
				: null;
	const basePlan = allPlans.find((plan) => plan.id === planId) ?? null;
	const baseRecord =
		allRecords.find((record) => record.id === recordId) ?? null;
	const carId =
		intent.kind === 'save-plan'
			? intent.plan.carId
			: intent.kind === 'save-service'
				? intent.carId
				: (basePlan?.carId ?? baseRecord?.carId);
	if (!carId || (planId && !basePlan) || (recordId && !baseRecord))
		throw new Error('The maintenance record is unavailable.');
	const current = view.current.collections.find(
		(collection) => collection.carId === carId,
	) ?? { carId, version: 0, plans: [], records: [] };
	let command: MaintenanceChange;
	if (intent.kind === 'save-plan' || intent.kind === 'transition-plan') {
		const input =
			intent.kind === 'save-plan'
				? {
						componentId: intent.plan.componentId ?? null,
						name: intent.plan.name,
						intervalDays:
							intent.plan.intervalUnit === 'days'
								? intent.plan.intervalValue
								: null,
						intervalSessions: intent.plan.intervalSessions ?? null,
						intervalUnit: intent.plan.intervalUnit,
						intervalValue: intent.plan.intervalValue,
						baselineAt:
							basePlan?.baselineAt ??
							intent.plan.baselineAt ??
							context.createdAt,
						baselineSessionCount:
							basePlan?.baselineSessionCount ??
							intent.plan.baselineSessionCount,
					}
				: (basePlan as PlanRecord);
		command = {
			type: 'maintenance.change',
			entity: 'plan',
			action:
				intent.kind === 'save-plan'
					? 'save'
					: intent.action === 'resume'
						? 'resume'
						: intent.action,
			carId,
			baseVersion: current.version,
			planId: planId ?? context.entityId,
			base: basePlan,
			input: {
				componentId: input.componentId,
				name: input.name,
				intervalDays: input.intervalDays,
				intervalSessions: input.intervalSessions,
				intervalUnit: input.intervalUnit,
				intervalValue: input.intervalValue,
				baselineAt: input.baselineAt,
				baselineSessionCount: input.baselineSessionCount,
			},
		};
	} else {
		const plan =
			basePlan ??
			allPlans.find((plan) => plan.id === baseRecord?.planId) ??
			null;
		const input =
			intent.kind === 'save-service'
				? {
						componentId:
							plan?.componentId ??
							intent.service.componentId ??
							baseRecord?.componentId ??
							null,
						performedAt: intent.service.performedAt,
						description: intent.service.description,
						notes: intent.service.notes ?? null,
						cost: intent.service.cost ?? null,
						currency: intent.service.currency ?? null,
					}
				: (baseRecord as ServiceRecord);
		command = {
			type: 'maintenance.change',
			entity: 'service',
			baselineSessionCount: context.sessionCounts.get(carId) ?? 0,
			action:
				intent.kind === 'save-service'
					? 'save'
					: intent.kind === 'undo-activity'
						? 'archive'
						: intent.action,
			carId,
			baseVersion: current.version,
			recordId: recordId ?? context.entityId,
			base: baseRecord,
			planBase: plan,
			input: {
				componentId: input.componentId,
				performedAt: input.performedAt,
				description: input.description,
				notes: input.notes,
				cost: input.cost,
				currency: input.currency,
			},
		};
	}
	const related = (operation: MaintenanceOperation): boolean => {
		if (operation.carId !== carId) return false;
		const change = operation.command;
		const ids = (value: MaintenanceChange) =>
			value.entity === 'plan'
				? [value.planId]
				: [value.recordId, value.planBase?.id].filter(Boolean);
		return ids(command).some((id) => ids(change).includes(id));
	};
	return {
		ownerKey: context.ownerKey,
		operationId: context.operationId,
		carId,
		command,
		createdAt: context.createdAt,
		sessionCount: context.sessionCounts.get(carId) ?? 0,
		sequence:
			Math.max(0, ...view.operations.map((operation) => operation.sequence)) +
			1,
		status: 'pending',
		dependencies: [
			...new Set([
				...context.dependencies
					.filter((operation) => operation.carId === carId)
					.map((operation) => operation.operationId),
				...view.operations
					.filter(related)
					.map((operation) => operation.operationId),
			]),
		],
	};
};
/**
 * Rebases a pending dependent command onto an acknowledged Maintenance collection
 * without replacing its intended edit. Called during acknowledgement so replay
 * compares against the saved prerequisite rather than its temporary local version.
 */
export const rebaseMaintenanceOperation = (
	operation: MaintenanceOperation,
	acknowledgedId: string,
	collection: MaintenanceCollection,
): MaintenanceOperation => {
	if (!operation.dependencies.includes(acknowledgedId)) return operation;
	const command = operation.command;
	const next: MaintenanceChange =
		command.entity === 'plan'
			? {
					...command,
					baseVersion: collection.version,
					base: command.base
						? (collection.plans.find((plan) => plan.id === command.planId) ??
							command.base)
						: null,
				}
			: {
					...command,
					baseVersion: collection.version,
					base: command.base
						? (collection.records.find(
								(record) => record.id === command.recordId,
							) ?? command.base)
						: null,
					planBase: command.planBase
						? (collection.plans.find(
								(plan) => plan.id === command.planBase?.id,
							) ?? command.planBase)
						: null,
				};
	return {
		...operation,
		command: next,
		dependencies: operation.dependencies.filter((id) => id !== acknowledgedId),
	};
};
