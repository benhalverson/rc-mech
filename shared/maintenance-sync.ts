import type { z } from 'zod';
import type { consumableSnapshot } from '../src/consumable-sync-contract';
export type ConsumableRecord = z.infer<typeof consumableSnapshot>;

import type {
	maintenancePlanSnapshot,
	maintenanceSyncCommandInput,
	serviceRecordSnapshot,
} from '../src/maintenance-sync-contract';
export type PlanRecord = z.infer<typeof maintenancePlanSnapshot>;
export type ServiceRecord = z.infer<typeof serviceRecordSnapshot>;
export type MaintenanceChange = z.infer<typeof maintenanceSyncCommandInput>;
export type MaintenanceCollection = Readonly<{
	carId: string;
	version: number;
	plans: readonly PlanRecord[];
	records: readonly ServiceRecord[];
	consumables?: readonly ConsumableRecord[];
}>;

export const maintenanceBaseMatches = (
	base: PlanRecord | ServiceRecord | ConsumableRecord | null,
	current: PlanRecord | ServiceRecord | ConsumableRecord | null,
): boolean =>
	base === null
		? current === null
		: current !== null &&
			Object.entries(base).every(
				([key, value]) => current[key as keyof typeof current] === value,
			);

/**
 * Applies validated plan/service intent for both server admission and offline
 * materialization. Stable history IDs and captured service baselines are preserved;
 * callers supply time/usage and perform their own authorization and persistence.
 */
export const applyMaintenanceChange = (
	collection: MaintenanceCollection,
	change: MaintenanceChange,
	now: string,
	sessionCount: number,
): MaintenanceCollection => {
	if (change.entity === 'consumable') {
		const records = new Map(
			(collection.consumables ?? []).map((entry) => [entry.id, entry]),
		);
		const input =
			change.action === 'save' ? change.input : (change.base ?? change.input);
		records.set(change.entryId, {
			...input,
			id: change.entryId,
			carId: change.carId,
			prefilledFromSetupId: change.base?.prefilledFromSetupId ?? null,
			createdAt: change.base?.createdAt ?? now,
			updatedAt: now,
			archivedAt: change.action === 'archive' ? now : null,
		});
		return { ...collection, consumables: [...records.values()] };
	}
	const plans = new Map(collection.plans.map((plan) => [plan.id, plan]));
	const records = new Map(
		collection.records.map((record) => [record.id, record]),
	);
	if (change.entity === 'plan') {
		const base = change.base;
		const status =
			change.action === 'pause'
				? 'paused'
				: change.action === 'archive'
					? 'archived'
					: change.action === 'save'
						? (base?.status ?? 'active')
						: 'active';
		plans.set(change.planId, {
			id: change.planId,
			carId: change.carId,
			...(change.action === 'save' ? change.input : (base ?? change.input)),
			status,
			pauseReason: status === 'paused' ? 'manual' : null,
			pausedAt: status === 'paused' ? (base?.pausedAt ?? now) : null,
		});
	} else {
		const base = change.base;
		const plan = change.planBase;
		const input =
			change.action === 'save' ? change.input : (base ?? change.input);
		const baselineAt = input.performedAt;
		const record: ServiceRecord = {
			id: change.recordId,
			carId: change.carId,
			...input,
			planId: plan?.id ?? null,
			baselineAt,
			baselineSessionCount:
				base?.baselineSessionCount ?? (plan ? sessionCount : null),
			previousBaselineAt: base?.previousBaselineAt ?? plan?.baselineAt ?? null,
			previousBaselineSessionCount:
				base?.previousBaselineSessionCount ??
				plan?.baselineSessionCount ??
				null,
			deletedAt: change.action === 'archive' ? now : null,
		};
		records.set(record.id, record);
		if (plan) {
			if (!base)
				plans.set(plan.id, {
					...plan,
					baselineAt,
					baselineSessionCount: sessionCount,
				});
			else if (
				change.action === 'archive' &&
				plan.baselineAt === base.baselineAt &&
				base.previousBaselineAt
			)
				plans.set(plan.id, {
					...plan,
					baselineAt: base.previousBaselineAt,
					baselineSessionCount: base.previousBaselineSessionCount ?? 0,
				});
			else if (
				change.action === 'restore' &&
				plan.baselineAt === base.previousBaselineAt
			)
				plans.set(plan.id, {
					...plan,
					baselineAt: base.baselineAt,
					baselineSessionCount: base.baselineSessionCount ?? 0,
				});
			else if (change.action === 'save' && plan.baselineAt === base.baselineAt)
				plans.set(plan.id, { ...plan, baselineAt });
		}
	}
	return {
		...collection,
		plans: [...plans.values()],
		records: [...records.values()],
	};
};
