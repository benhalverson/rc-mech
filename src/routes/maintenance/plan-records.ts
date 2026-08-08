import { eq } from 'drizzle-orm';
import { db } from '../../db';
import {
	calculateMaintenanceDue,
	type MaintenanceIntervalUnit,
	type MaintenanceStatus,
} from '../../maintenance-policy';
import { maintenancePlan } from '../../schema';
import type { AppContext } from '../../types';
import { ownedCar } from '../cars/car-records';
import { driveSessionCount } from './drive-records';

export const planSessionCount = driveSessionCount;

export const planDue = (
	value: typeof maintenancePlan.$inferSelect,
	currentSessionCount: number,
	timezone: string,
	now = new Date().toISOString(),
) => {
	const intervalUnit = (value.intervalUnit ||
		(value.intervalDays ? 'days' : 'none')) as MaintenanceIntervalUnit;
	const intervalValue = value.intervalValue || value.intervalDays || 1;
	return {
		...value,
		intervalUnit,
		intervalValue: intervalUnit === 'none' ? null : intervalValue,
		currentSessionCount,
		timezone,
		...calculateMaintenanceDue({
			status: value.status as MaintenanceStatus,
			baselineAt: value.baselineAt,
			baselineSessionCount: value.baselineSessionCount,
			intervalUnit,
			intervalValue,
			intervalSessions: value.intervalSessions,
			currentSessionCount,
			now,
			timezone,
		}),
	};
};

export const carPlan = async (c: AppContext, planId: string) => {
	const value = await db(c.env)
		.select()
		.from(maintenancePlan)
		.where(eq(maintenancePlan.id, planId))
		.get();
	return value && (await ownedCar(c, value.carId)) ? value : undefined;
};
