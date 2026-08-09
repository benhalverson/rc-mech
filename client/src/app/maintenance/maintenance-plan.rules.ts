import type { MaintenancePlan, PlanState } from './maintenance.models';

export type MaintenancePlanIntervalUnit = 'days' | 'weeks' | 'months';

export const calendarDays = (
	value: number,
	unit: MaintenancePlanIntervalUnit,
): number =>
	unit === 'weeks' ? value * 7 : unit === 'months' ? value * 30 : value;

export const calculatePlanState = (
	plan: MaintenancePlan,
	now = new Date(),
	sessionCount = 0,
): PlanState => {
	if (plan.dueStatus) return plan.dueStatus;
	if (plan.status === 'archived') return 'archived';
	if (plan.status === 'paused') return 'paused';
	const baseline = plan.baselineAt
		? new Date(plan.baselineAt).getTime()
		: Number.POSITIVE_INFINITY;
	const intervalDays = plan.intervalDays ?? 0;
	const calendarDueAt = baseline + intervalDays * 86400000;
	const calendarDue = intervalDays > 0 && now.getTime() >= calendarDueAt;
	const sessionsDue = plan.intervalSessions
		? sessionCount >= (plan.baselineSessionCount ?? 0) + plan.intervalSessions
		: false;
	if (calendarDue || sessionsDue) {
		const overdue = plan.nextDueAt
			? now.getTime() > new Date(plan.nextDueAt).getTime()
			: calendarDue && now.getTime() > calendarDueAt;
		return overdue ? 'overdue' : 'due';
	}
	return 'upcoming';
};

export const filterMaintenancePlans = (
	plans: readonly MaintenancePlan[],
	filter: 'all' | PlanState,
): MaintenancePlan[] =>
	plans.filter(
		(plan) => filter === 'all' || calculatePlanState(plan) === filter,
	);
