import { Hono } from 'hono';
import type { AppDependencies } from '../app-dependencies';
import type { AppEnv } from '../types';
import { createConsumableMaintenanceRoutes } from './maintenance/consumable-maintenance';
import { createConsumableRoutes } from './maintenance/consumables';
import { createDriveSessionRoutes } from './maintenance/drive-sessions';
import { createMaintenancePlanRoutes } from './maintenance/maintenance-plans';
import { createRaceRecordingRoutes } from './maintenance/race-recordings';
import { createServiceRecordRoutes } from './maintenance/service-records';

export const createMaintenanceRoutes = (dependencies: AppDependencies) =>
	new Hono<AppEnv>()
		.route('/', createConsumableRoutes())
		.route('/', createConsumableMaintenanceRoutes())
		.route('/', createDriveSessionRoutes())
		.route('/', createRaceRecordingRoutes(dependencies))
		.route('/', createMaintenancePlanRoutes())
		.route('/', createServiceRecordRoutes());
