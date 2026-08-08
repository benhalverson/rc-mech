import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createSetupImportRoutes } from './setups/setup-imports';
import { createSetupSnapshotRoutes } from './setups/setup-snapshots';

export const createSetupsRoutes = () =>
	new Hono<AppEnv>()
		.route('/', createSetupSnapshotRoutes())
		.route('/', createSetupImportRoutes());
