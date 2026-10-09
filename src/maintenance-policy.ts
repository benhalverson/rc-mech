export type {
	DueCalculation,
	DueCalculationInput,
	MaintenanceIntervalUnit,
	MaintenanceStatus,
} from '../shared/maintenance-due';
export {
	addCalendarInterval,
	calculateMaintenanceDue,
} from '../shared/maintenance-due';

import type { MaintenanceStatus } from '../shared/maintenance-due';

export const canTransitionMaintenance = (
	from: MaintenanceStatus,
	to: MaintenanceStatus,
): boolean =>
	(from === 'active' && (to === 'paused' || to === 'archived')) ||
	(from === 'paused' && (to === 'active' || to === 'archived')) ||
	(from === 'archived' && to === 'active');
