import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createConsumableMaintenanceRoutes } from './maintenance/consumable-maintenance';
import { createConsumableRoutes } from './maintenance/consumables';
import { createDriveSessionRoutes } from './maintenance/drive-sessions';
import { createMaintenancePlanRoutes } from './maintenance/maintenance-plans';
import { createServiceRecordRoutes } from './maintenance/service-records';

export const createMaintenanceRoutes = () =>
	new Hono<AppEnv>()
		.route('/', createConsumableRoutes())
		.route('/', createConsumableMaintenanceRoutes())
		.route('/', createDriveSessionRoutes())
		.route('/', createMaintenancePlanRoutes())
		.route('/', createServiceRecordRoutes());
