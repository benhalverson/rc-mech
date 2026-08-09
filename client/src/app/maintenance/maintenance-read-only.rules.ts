import type {
	MaintenanceCar,
	MaintenancePlan,
	ServiceRecord,
} from './maintenance.models';

const carIsArchived = (
	carId: string,
	cars: readonly MaintenanceCar[],
): boolean => Boolean(cars.find((car) => car.id === carId)?.archivedAt);

export const maintenancePlanIsReadOnly = (
	plan: MaintenancePlan,
	cars: readonly MaintenanceCar[],
): boolean => carIsArchived(plan.carId, cars) || plan.status === 'archived';

export const serviceRecordIsReadOnly = (
	record: ServiceRecord,
	cars: readonly MaintenanceCar[],
): boolean => carIsArchived(record.carId, cars) || Boolean(record.deletedAt);
