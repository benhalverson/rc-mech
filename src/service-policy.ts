export type ServiceRecordLifecycle = { deletedAt: string | null };

export const canEditServiceRecord = (value: ServiceRecordLifecycle): boolean => value.deletedAt === null;
export const canDeleteServiceRecord = (value: ServiceRecordLifecycle): boolean => value.deletedAt === null;

export const shouldRestoreBaseline = (record: { planId: string | null; baselineAt: string; previousBaselineAt: string | null }, plan: { baselineAt: string } | undefined): boolean =>
	Boolean(record.planId && record.previousBaselineAt && plan && plan.baselineAt === record.baselineAt);
