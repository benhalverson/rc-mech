import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createCarRoutes } from './cars/cars';
import { createComponentRoutes } from './cars/components';

export const createCarsRoutes = () =>
	new Hono<AppEnv>()
		.route('/', createCarRoutes())
		.route('/', createComponentRoutes());
