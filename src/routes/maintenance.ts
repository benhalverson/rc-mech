import { Hono } from 'hono';
import type { AppDependencies } from '../app-dependencies';
import { createCornerClipRoutes } from '../driving-analysis/clips/corner-clip-routes';
import { createSubjectFrameRoutes } from '../driving-analysis/race-recording/subject-frame-routes';
import type { AppEnv } from '../types';
import { createConsumableMaintenanceRoutes } from './maintenance/consumable-maintenance';
import { createConsumableRoutes } from './maintenance/consumables';
import { createCornerEvidenceRoutes } from './maintenance/corner-evidence';
import { createDriveSessionRoutes } from './maintenance/drive-sessions';
import { createDrivingAnalysisRoutes } from './maintenance/driving-analyses';
import { createMaintenancePlanRoutes } from './maintenance/maintenance-plans';
import { createRaceRecordingRoutes } from './maintenance/race-recordings';
import { createServiceRecordRoutes } from './maintenance/service-records';

export const createMaintenanceRoutes = (dependencies: AppDependencies) =>
	new Hono<AppEnv>()
		.route('/', createConsumableRoutes())
		.route('/', createConsumableMaintenanceRoutes())
		.route('/', createDriveSessionRoutes())
		.route('/', createDrivingAnalysisRoutes(dependencies))
		.route('/', createCornerEvidenceRoutes())
		.route('/', createCornerClipRoutes())
		.route('/', createSubjectFrameRoutes())
		.route('/', createRaceRecordingRoutes(dependencies))
		.route('/', createMaintenancePlanRoutes())
		.route('/', createServiceRecordRoutes());
