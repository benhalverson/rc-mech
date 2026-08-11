import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createCarSyncRoutes } from './cars/car-sync';
import { createCarRoutes } from './cars/cars';
import { createComponentRoutes } from './cars/components';

export const createCarsRoutes = () =>
	new Hono<AppEnv>()
		.route('/', createCarSyncRoutes())
		.route('/', createCarRoutes())
		.route('/', createComponentRoutes());
