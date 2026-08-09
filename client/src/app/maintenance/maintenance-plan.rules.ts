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

export const localDateTime = (date: Date, timezone: string): string => {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: timezone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(date);
	const get = (type: string) =>
		parts.find((part) => part.type === type)?.value ?? '';
	return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
};

export const localDateTimeToIso = (value: string, timezone: string): string => {
	const [date, time] = value.split('T');
	if (!date || !time) return '';
	const [year, month, day] = date.split('-').map(Number);
	const [hour, minute] = time.split(':').map(Number);
	const asUtc = Date.UTC(year, month - 1, day, hour, minute);
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: timezone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(new Date(asUtc));
	const get = (type: string) =>
		Number(parts.find((part) => part.type === type)?.value);
	const offset =
		Date.UTC(
			get('year'),
			get('month') - 1,
			get('day'),
			get('hour'),
			get('minute'),
		) - asUtc;
	return new Date(asUtc - offset).toISOString();
};
